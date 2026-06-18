import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

const runIntegration = Boolean(process.env.RUN_INTEGRATION);

// Dynamic imports AFTER vi.mock (none here), gated so non-integration runs skip
// the real DB import entirely.
const { closeDb, db } = await import('../db/client.js');
const { replaceTiers, listTiersWithRemaining } = await import('./event_tiers_service.js');

describe.skipIf(!runIntegration)('event_tiers_service', () => {
  let tenantId: string;
  let eventId: string;

  beforeAll(async () => {
    const t = await db.execute<{ id: string }>(
      sql`insert into tenants (name, slug, status) values ('TierSvc', ${'tiersvc-' + Date.now()}, 'active') returning id`,
    );
    tenantId = ((t as unknown as { id: string }[])[0]!).id;
    const e = await db.execute<{ id: string }>(
      sql`insert into events (tenant_id, name, starts_at, ends_at, price_paise, status, address_json, tz_name)
          values (${tenantId}, 'E', now() + interval '1 day', now() + interval '2 day', 0, 'draft', '{"city":"Pune"}', 'Asia/Kolkata') returning id`,
    );
    eventId = ((e as unknown as { id: string }[])[0]!).id;
  });

  afterAll(async () => {
    await db.execute(sql`delete from event_booking_tickets where tier_id in (select id from event_ticket_tiers where event_id = ${eventId})`);
    await db.execute(sql`delete from event_ticket_tiers where event_id = ${eventId}`);
    await db.execute(sql`delete from events where id = ${eventId}`);
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
    await closeDb();
  });

  it('replaceTiers inserts tiers, syncs min price, and reports remaining', async () => {
    const tiers = await db.transaction((tx) =>
      replaceTiers(tx, eventId, tenantId, [
        { name: 'VIP', pricePaise: 50000, capacity: 2 },
        { name: 'GA', pricePaise: 20000, capacity: null },
      ]),
    );
    expect(tiers).toHaveLength(2);
    const withRemaining = await listTiersWithRemaining(db, eventId);
    const vip = withRemaining.find((t) => t.name === 'VIP')!;
    const ga = withRemaining.find((t) => t.name === 'GA')!;
    expect(vip.remaining).toBe(2);
    expect(ga.remaining).toBeNull();
    const ev = await db.execute<{ price_paise: number }>(sql`select price_paise from events where id = ${eventId}`);
    expect(Number((ev as unknown as { price_paise: number }[])[0]!.price_paise)).toBe(20000);
  });

  it('replaceTiers is replace-all (old tiers soft-deleted)', async () => {
    await db.transaction((tx) => replaceTiers(tx, eventId, tenantId, [{ name: 'Only', pricePaise: 10000, capacity: 5 }]));
    const live = await listTiersWithRemaining(db, eventId);
    expect(live.map((t) => t.name)).toEqual(['Only']);
  });

  it('replaceTiers rejects an empty tier set', async () => {
    await expect(db.transaction((tx) => replaceTiers(tx, eventId, tenantId, []))).rejects.toThrow();
  });
});
