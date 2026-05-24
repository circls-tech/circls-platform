import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db, pingDb } from './client.js';
import { isExclusionViolation } from './errors.js';
import { arenas, tenants, venues } from './schema/index.js';

// Proves the slots inventory invariant directly at the database level (no app code).
const runIntegration = Boolean(process.env.RUN_INTEGRATION);

describe.skipIf(!runIntegration)('slots GIST exclusion (inventory invariant)', () => {
  let tenantId: string;
  let arenaId: string;

  beforeAll(async () => {
    await pingDb();
    const [t] = await db
      .insert(tenants)
      .values({ name: 'SlotsExcl', slug: `slots-excl-${Date.now()}` })
      .returning();
    const [v] = await db.insert(venues).values({ tenantId: t!.id, name: 'V' }).returning();
    const [a] = await db.insert(arenas).values({ venueId: v!.id, name: 'A' }).returning();
    tenantId = t!.id;
    arenaId = a!.id;
  });

  afterAll(async () => {
    await db.execute(sql`delete from slots where tenant_id = ${tenantId}`);
    await closeDb();
  });

  it('rejects an overlapping live slot on the same arena', async () => {
    const startIso = '2027-03-01T10:00:00Z';
    const endIso = '2027-03-01T11:00:00Z';
    const overlapStartIso = '2027-03-01T10:30:00Z';
    const overlapEndIso = '2027-03-01T11:30:00Z';

    await db.execute(sql`
      insert into slots (tenant_id, arena_id, time_range, price_paise, status)
      values (${tenantId}, ${arenaId},
              tstzrange(${startIso}::timestamptz, ${endIso}::timestamptz, '[)'),
              5000, 'open')
    `);

    let threw = false;
    try {
      await db.execute(sql`
        insert into slots (tenant_id, arena_id, time_range, price_paise, status)
        values (${tenantId}, ${arenaId},
                tstzrange(${overlapStartIso}::timestamptz, ${overlapEndIso}::timestamptz, '[)'),
                5000, 'open')
      `);
    } catch (err) {
      threw = true;
      expect(isExclusionViolation(err)).toBe(true);
    }
    expect(threw).toBe(true);
  });

  it('a soft-deleted slot does NOT block an overlapping live slot', async () => {
    const startIso = '2027-03-02T14:00:00Z';
    const endIso = '2027-03-02T15:00:00Z';

    // Insert a slot that is soft-deleted (deleted_at is set)
    await db.execute(sql`
      insert into slots (tenant_id, arena_id, time_range, price_paise, status, deleted_at)
      values (${tenantId}, ${arenaId},
              tstzrange(${startIso}::timestamptz, ${endIso}::timestamptz, '[)'),
              5000, 'open', now())
    `);

    // An overlapping live slot should succeed because the exclusion WHERE clause
    // only applies when deleted_at IS NULL.
    await expect(
      db.execute(sql`
        insert into slots (tenant_id, arena_id, time_range, price_paise, status)
        values (${tenantId}, ${arenaId},
                tstzrange(${startIso}::timestamptz, ${endIso}::timestamptz, '[)'),
                5000, 'open')
      `),
    ).resolves.toBeDefined();
  });
});
