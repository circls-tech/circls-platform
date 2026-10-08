import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MAX_PENDING_SLOTS_PER_USER, MAX_SLOTS_PER_BOOKING } from '../lib/booking_limits.js';

// Consumer slot checkout ceilings: how many slots one booking may claim, and
// how many a customer may hold under bookings that are still unpaid. Both
// bound what a single account can take off sale before paying for anything.
// Integration (RUN_INTEGRATION + a real Postgres).

vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      owner: { uid: 'fbuid_blowner', email: 'blowner@x.com', email_verified: true },
      buyer: { uid: 'fbuid_blbuyer', phone_number: '+919800000061' },
      buyer2: { uid: 'fbuid_blbuyer2', phone_number: '+919800000062' },
    };
    const u = map[token];
    if (!u) throw new Error('bad token');
    return u;
  }),
}));

const { closeDb, db } = await import('../db/client.js');
const { buildServer } = await import('../server.js');

const runIntegration = Boolean(process.env.RUN_INTEGRATION);
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

describe.skipIf(!runIntegration)('consumer slot booking limits', () => {
  let app: FastifyInstance;
  let tenantId: string;
  let venueId: string;
  let arenaId: string;
  // Open, future, hourly slots on one arena — one more than the per-user cap.
  let slotIds: string[];

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();

    const t = await app.inject({
      method: 'POST',
      url: '/v1/tenants',
      headers: bearer('owner'),
      payload: { name: 'Limits Co', slug: `limits-${Date.now()}`, country: 'India', acceptTerms: true },
    });
    tenantId = t.json().id;

    const v = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/venues`,
      headers: bearer('owner'),
      payload: { name: 'Limits Venue' },
    });
    venueId = v.json().id;

    const a = await app.inject({
      method: 'POST',
      url: `/v1/venues/${venueId}/arenas`,
      headers: bearer('owner'),
      payload: { name: 'Limits Court', slotDurationMin: 60 },
    });
    arenaId = a.json().id;

    // New listings start in review; consumers only see live ones.
    await db.execute(sql`update venues set status = 'active' where id = ${venueId}::uuid`);
    await db.execute(sql`update arenas set status = 'active' where id = ${arenaId}::uuid`);

    const rows = (await db.execute(sql`
      insert into slots (tenant_id, arena_id, time_range, price_paise, status)
      select ${tenantId}::uuid, ${arenaId}::uuid,
             tstzrange(now() + interval '3 days' + (g * interval '1 hour'),
                       now() + interval '3 days' + ((g + 1) * interval '1 hour'), '[)'),
             10000, 'open'
      from generate_series(0, ${MAX_PENDING_SLOTS_PER_USER}) as g
      returning id
    `)) as unknown as { id: string }[];
    slotIds = rows.map((r) => r.id);
  });

  afterAll(async () => {
    await db.execute(sql`delete from payments where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from slots where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from bookings where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from audit_log where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from notifications where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from arenas where venue_id = ${venueId}`);
    await db.execute(sql`delete from venues where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenant_members where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
    await app.close();
    await closeDb();
  });

  const book = (token: string, ids: string[]) =>
    app.inject({
      method: 'POST',
      url: '/v1/consumer/bookings',
      headers: bearer(token),
      payload: { slotIds: ids, customerName: 'Cap Tester', customerContact: '+919800000099' },
    });

  it('rejects a cart above the per-booking cap with 400', async () => {
    const res = await book('buyer', slotIds.slice(0, MAX_SLOTS_PER_BOOKING + 1));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('bad_request');
  });

  it('caps the slots one customer may hold under unpaid bookings', async () => {
    // Fill the cap: this checkout is left unpaid, so its slots stay locked.
    const first = await book('buyer', slotIds.slice(0, MAX_PENDING_SLOTS_PER_USER));
    expect(first.statusCode).toBe(200);

    // One more slot for the same customer: refused until those are paid or swept.
    const extra = await book('buyer', [slotIds[MAX_PENDING_SLOTS_PER_USER]!]);
    expect(extra.statusCode).toBe(409);
    expect(extra.json().error.code).toBe('too_many_pending_slots');
    expect(extra.json().error.details).toMatchObject({
      max: MAX_PENDING_SLOTS_PER_USER,
      held: MAX_PENDING_SLOTS_PER_USER,
    });

    // The cap is per customer — the slot is still bookable by someone else.
    const other = await book('buyer2', [slotIds[MAX_PENDING_SLOTS_PER_USER]!]);
    expect(other.statusCode).toBe(200);
  });
});
