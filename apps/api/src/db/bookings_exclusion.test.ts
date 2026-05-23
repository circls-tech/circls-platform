import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db, pingDb } from './client.js';
import { isExclusionViolation } from './errors.js';
import { arenas, tenants, venues } from './schema/index.js';

// Proves the inventory invariant directly at the database level (no app code).
const runIntegration = Boolean(process.env.RUN_INTEGRATION);

describe.skipIf(!runIntegration)('bookings GIST exclusion (inventory invariant)', () => {
  let tenantId: string;
  let venueId: string;
  let arenaId: string;

  beforeAll(async () => {
    await pingDb();
    const [t] = await db.insert(tenants).values({ name: 'Excl', slug: `excl-${Date.now()}` }).returning();
    const [v] = await db.insert(venues).values({ tenantId: t!.id, name: 'V' }).returning();
    const [a] = await db.insert(arenas).values({ venueId: v!.id, name: 'A' }).returning();
    tenantId = t!.id;
    venueId = v!.id;
    arenaId = a!.id;
  });
  afterAll(async () => {
    await closeDb();
  });

  const book = (startIso: string, endIso: string, status = 'confirmed') =>
    db.execute(sql`
      insert into bookings (tenant_id, venue_id, item_type, slot_arena_id, time_range, channel, payment_method, status)
      values (${tenantId}, ${venueId}, 'slot', ${arenaId},
              tstzrange(${startIso}::timestamptz, ${endIso}::timestamptz, '[)'),
              'walkin', 'external', ${status})
    `);

  it('rejects an overlapping non-cancelled slot booking on the same arena', async () => {
    await book('2026-06-01T10:00:00Z', '2026-06-01T11:00:00Z');
    let threw = false;
    try {
      await book('2026-06-01T10:30:00Z', '2026-06-01T11:30:00Z');
    } catch (err) {
      threw = true;
      expect(isExclusionViolation(err)).toBe(true);
    }
    expect(threw).toBe(true);
  });

  it('allows an adjacent (non-overlapping) booking', async () => {
    await expect(book('2026-06-01T11:00:00Z', '2026-06-01T12:00:00Z')).resolves.toBeDefined();
  });

  it('a cancelled booking does not hold the slot', async () => {
    await book('2026-06-02T09:00:00Z', '2026-06-02T10:00:00Z', 'cancelled');
    await expect(book('2026-06-02T09:00:00Z', '2026-06-02T10:00:00Z', 'confirmed')).resolves.toBeDefined();
  });
});
