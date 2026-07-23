/**
 * Recurring events (series) — integration tests (RUN_INTEGRATION + DB).
 *
 * Covers: creating a series via `occurrences` (with per-date tier overrides),
 * the series read/publish/cancel endpoints, admin approval cascading across
 * the series, and the consumer-side grouping + shared gallery.
 */
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      owner: { uid: 'fbuid_series_owner', email: 'seriesowner@x.com', email_verified: true },
    };
    const u = map[token];
    if (!u) throw new Error('bad token');
    return u;
  }),
}));

const { closeDb, db } = await import('../db/client.js');
const { buildServer } = await import('../server.js');
const { approveListing } = await import('../services/listing_service.js');
const { getPublicEventById, listPublicUpcomingEvents } = await import(
  '../services/consumer_service.js'
);

const runIntegration = Boolean(process.env.RUN_INTEGRATION);
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

interface EventRow {
  id: string;
  seriesId: string | null;
  status: string;
  startsAt: string;
}
interface SeriesResult {
  seriesId: string;
  count: number;
  events: EventRow[];
}

describe.skipIf(!runIntegration)('recurring event series', () => {
  let app: FastifyInstance;
  let ownerId: string;
  let tenantId: string;
  let series: SeriesResult;
  const SUFFIX = Date.now();

  // Far-future dates so "upcoming" filters keep passing (see repo time-bomb lore).
  const OCCURRENCES = [
    { startsAt: '2032-05-06T10:00:00.000Z', endsAt: '2032-05-06T12:00:00.000Z' },
    {
      startsAt: '2032-05-07T10:00:00.000Z',
      endsAt: '2032-05-07T12:00:00.000Z',
      tiers: [{ name: 'Finale', pricePaise: 50000 }],
    },
    { startsAt: '2032-05-13T10:00:00.000Z', endsAt: '2032-05-13T12:00:00.000Z' },
  ];

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer('owner') });
    ownerId = (me.json() as { id: string }).id;
    const t = await app.inject({
      method: 'POST',
      url: '/v1/tenants',
      headers: bearer('owner'),
      payload: { name: 'SeriesOrg', slug: `seriesorg-${SUFFIX}`, country: 'India', acceptTerms: true },
    });
    tenantId = (t.json() as { id: string }).id;
  });

  afterAll(async () => {
    await db.execute(sql`delete from audit_log where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from event_images where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from events where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenant_members where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
    await db.execute(sql`delete from users where id = ${ownerId}`);
    await app.close();
    await closeDb();
  });

  it('creates one draft event per occurrence sharing a series_id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/events`,
      headers: bearer('owner'),
      payload: {
        addressJson: { line1: '5 MG Rd', city: 'Pune' },
        tzName: 'Asia/Kolkata',
        name: 'Weekly Dance Workshop',
        tiers: [{ name: 'General', pricePaise: 20000 }],
        occurrences: OCCURRENCES,
      },
    });
    expect(res.statusCode).toBe(200);
    series = res.json() as SeriesResult;
    expect(series.count).toBe(3);
    expect(series.events).toHaveLength(3);
    const ids = new Set(series.events.map((e) => e.seriesId));
    expect(ids.size).toBe(1);
    expect(series.seriesId).toBe(series.events[0]!.seriesId);
    // Sorted soonest-first, all drafts.
    expect(series.events.map((e) => e.startsAt)).toEqual(OCCURRENCES.map((o) => o.startsAt));
    expect(series.events.every((e) => e.status === 'draft')).toBe(true);
  });

  it('applies per-date tier overrides (base tiers elsewhere)', async () => {
    const raw = await db.execute<Record<string, unknown>>(sql`
      select event_id, name, price_paise from event_ticket_tiers
      where tenant_id = ${tenantId} and deleted_at is null
    `);
    const rows = raw as unknown as { event_id: string; name: string; price_paise: string }[];
    const byEvent = new Map<string, { name: string; price: number }[]>();
    for (const r of rows) {
      const list = byEvent.get(r.event_id) ?? [];
      list.push({ name: r.name, price: Number(r.price_paise) });
      byEvent.set(r.event_id, list);
    }
    expect(byEvent.get(series.events[0]!.id)).toEqual([{ name: 'General', price: 20000 }]);
    expect(byEvent.get(series.events[1]!.id)).toEqual([{ name: 'Finale', price: 50000 }]);
    expect(byEvent.get(series.events[2]!.id)).toEqual([{ name: 'General', price: 20000 }]);
  });

  it('rejects a single-occurrence series', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/events`,
      headers: bearer('owner'),
      payload: {
        addressJson: { line1: 'x' },
        tzName: 'Asia/Kolkata',
        name: 'Too small',
        tiers: [{ name: 'General', pricePaise: 0 }],
        occurrences: [OCCURRENCES[0]],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('reads the series and publishes every draft at once', async () => {
    const get = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/event-series/${series.seriesId}`,
      headers: bearer('owner'),
    });
    expect(get.statusCode).toBe(200);
    expect((get.json() as { events: EventRow[] }).events).toHaveLength(3);

    const pub = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/event-series/${series.seriesId}/publish`,
      headers: bearer('owner'),
    });
    expect(pub.statusCode).toBe(200);
    const pubBody = pub.json() as SeriesResult;
    expect(pubBody.count).toBe(3);
    expect(pubBody.events.every((e) => e.status === 'pending_review')).toBe(true);

    // Nothing left in draft → conflict.
    const again = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/event-series/${series.seriesId}/publish`,
      headers: bearer('owner'),
    });
    expect(again.statusCode).toBe(409);
  });

  it('admin approval of one occurrence cascades to the whole series', async () => {
    await approveListing({ type: 'event', id: series.events[0]!.id, actorUserId: ownerId });
    const raw = await db.execute<Record<string, unknown>>(
      sql`select status from events where series_id = ${series.seriesId}`,
    );
    const rows = raw as unknown as { status: string }[];
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.status === 'published')).toBe(true);
  });

  it('consumer detail lists every upcoming date and shares the anchor gallery', async () => {
    // Attach a gallery to the anchor (earliest) occurrence only.
    await db.execute(sql`
      insert into event_images (event_id, tenant_id, storage_key, mime_type, size_bytes, position)
      values (${series.events[0]!.id}, ${tenantId}, ${'events/' + series.events[0]!.id + '/cover.jpg'}, 'image/jpeg', 123, 0)
    `);

    const last = await getPublicEventById(series.events[2]!.id);
    expect(last).not.toBeNull();
    expect(last!.seriesCount).toBe(3);
    expect(last!.seriesOccurrences?.map((o) => o.id)).toEqual(series.events.map((e) => e.id));
    // The last date has no images of its own — it borrows the anchor's.
    expect(last!.images.length).toBe(1);
  });

  it('consumer upcoming list collapses the series to one card', async () => {
    const rows = await listPublicUpcomingEvents({ limit: 100 });
    const mine = rows.filter((r) => r.seriesId === series.seriesId);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.id).toBe(series.events[0]!.id); // next upcoming occurrence
    expect(mine[0]!.seriesCount).toBe(3);
  });

  it('cancels every remaining date of the series at once', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/event-series/${series.seriesId}/cancel`,
      headers: bearer('owner'),
    });
    expect(res.statusCode).toBe(200);
    const raw = await db.execute<Record<string, unknown>>(
      sql`select status from events where series_id = ${series.seriesId}`,
    );
    const rows = raw as unknown as { status: string }[];
    expect(rows.every((r) => r.status === 'cancelled')).toBe(true);
  });
});
