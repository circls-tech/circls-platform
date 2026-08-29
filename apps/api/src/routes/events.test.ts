import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      owner: { uid: 'fbuid_evt_owner', email: 'evtowner@x.com', email_verified: true },
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

describe.skipIf(!runIntegration)('tenant event routes', () => {
  let app: FastifyInstance;
  let ownerId: string;
  let tenantId: string;
  const SUFFIX = Date.now();

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer('owner') });
    ownerId = (me.json() as { id: string }).id;
    const t = await app.inject({
      method: 'POST',
      url: '/v1/tenants',
      headers: bearer('owner'),
      payload: { name: 'EvtRoutes', slug: `evtroutes-${SUFFIX}`, country: 'India', acceptTerms: true },
    });
    tenantId = (t.json() as { id: string }).id;
  });

  afterAll(async () => {
    // Scoped to this suite's own slug namespace rather than this run's ids, so
    // a run that dies mid-way cannot leave rows that break the NEXT run. Both
    // the slug prefix and the mocked firebase uid belong to this file alone.
    // Keying off the current user id is not enough: each run deletes and
    // recreates that user, so older orphans stop matching it.
    const owned = sql`select id from tenants where slug like 'evtroutes-%'`;
    const ownedBookings = sql`select id from bookings where tenant_id in (${owned})`;
    const ownedEvents = sql`select id from events where tenant_id in (${owned})`;

    await db.execute(sql`delete from audit_log where tenant_id in (${owned})`);
    // A confirmed registration leaves a graph behind it: entry passes, answers
    // and ticket lines all point at the booking.
    await db.execute(sql`delete from qr_tickets where booking_id in (${ownedBookings})`);
    await db.execute(
      sql`delete from event_registration_answers where booking_id in (${ownedBookings})`,
    );
    await db.execute(
      sql`delete from event_booking_tickets where booking_id in (${ownedBookings})`,
    );
    await db.execute(sql`delete from bookings where tenant_id in (${owned})`);
    await db.execute(
      sql`delete from event_registration_questions where event_id in (${ownedEvents})`,
    );
    await db.execute(sql`delete from event_ticket_tiers where event_id in (${ownedEvents})`);
    await db.execute(sql`delete from events where tenant_id in (${owned})`);
    // Confirming a registration also queues a notification.
    await db.execute(sql`delete from notifications where tenant_id in (${owned})`);
    await db.execute(sql`delete from tenant_members where tenant_id in (${owned})`);
    await db.execute(sql`delete from tenants where id in (${owned})`);
    await db.execute(sql`delete from users where firebase_uid = 'fbuid_evt_owner'`);
    await app.close();
    await closeDb();
  });

  it('creates an org-scoped event via POST /v1/tenants/:tenantId/events', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/events`,
      headers: bearer('owner'),
      payload: {
        addressJson: { line1: '5 MG Rd', city: 'Pune' },
        tzName: 'Asia/Kolkata',
        name: 'Standalone Meetup',
        startsAt: '2030-05-01T10:00:00.000Z',
        endsAt: '2030-05-01T12:00:00.000Z',
        tiers: [{ name: 'General', pricePaise: 0 }],
      },
    });
    expect(res.statusCode).toBe(200);
    const ev = res.json();
    expect(ev.venueId).toBeNull();
    expect(ev.tzName).toBe('Asia/Kolkata');
  });

  it('accepts and round-trips per-tier QR config on the tier payload', async () => {
    const create = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/events`,
      headers: bearer('owner'),
      payload: {
        addressJson: { line1: '5 MG Rd', city: 'Pune' },
        tzName: 'Asia/Kolkata',
        name: 'Tiered QR Meetup',
        startsAt: '2030-06-01T10:00:00.000Z',
        endsAt: '2030-06-03T22:00:00.000Z',
        tiers: [
          {
            name: 'VIP',
            pricePaise: 5000,
            qrTicketConfig: { enabled: true, multiUse: true, maxScans: 2 },
          },
          { name: 'General', pricePaise: 0 },
          { name: 'Crew', pricePaise: 0, qrTicketConfig: { enabled: false } },
        ],
      },
    });
    expect(create.statusCode).toBe(200);
    const eventId = (create.json() as { id: string }).id;

    const read = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/events/${eventId}`,
      headers: bearer('owner'),
    });
    expect(read.statusCode).toBe(200);
    const tiers = (
      read.json() as {
        tiers: { name: string; qrTicketConfig: Record<string, unknown> | null }[];
      }
    ).tiers;
    expect(tiers.map((t) => t.name)).toEqual(['VIP', 'General', 'Crew']);
    // Custom rules are normalised and stored; omitted = null (inherit); a
    // disabled payload is kept as an explicit enabled:false marker.
    expect(tiers[0]!.qrTicketConfig).toMatchObject({ enabled: true, multiUse: true, maxScans: 2 });
    expect(tiers[1]!.qrTicketConfig).toBeNull();
    expect(tiers[2]!.qrTicketConfig).toMatchObject({ enabled: false });
  });

  it('rejects a payload with both venueId and addressJson', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/events`,
      headers: bearer('owner'),
      payload: {
        venueId: '00000000-0000-0000-0000-000000000000',
        addressJson: { line1: 'x' },
        tzName: 'Asia/Kolkata',
        name: 'Both',
        startsAt: '2030-05-01T10:00:00.000Z',
        endsAt: '2030-05-01T12:00:00.000Z',
        tiers: [{ name: 'General', pricePaise: 0 }],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a payload with neither venueId nor addressJson', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/events`,
      headers: bearer('owner'),
      payload: {
        name: 'Neither',
        startsAt: '2030-05-01T10:00:00.000Z',
        endsAt: '2030-05-01T12:00:00.000Z',
        tiers: [{ name: 'General', pricePaise: 0 }],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a standalone payload with an empty address object', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/events`,
      headers: bearer('owner'),
      payload: {
        addressJson: {},
        tzName: 'Asia/Kolkata',
        name: 'Empty Address',
        startsAt: '2030-05-01T10:00:00.000Z',
        endsAt: '2030-05-01T12:00:00.000Z',
        tiers: [{ name: 'General', pricePaise: 0 }],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('lists tenant events via GET /v1/tenants/:tenantId/events', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/events`,
      headers: bearer('owner'),
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json();
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.some((r: { venueId: string | null }) => r.venueId === null)).toBe(true);
  });

  describe('external registrations', () => {
    let eventId: string;
    let tierId: string;
    let questionId: string;

    beforeAll(async () => {
      const create = await app.inject({
        method: 'POST',
        url: `/v1/tenants/${tenantId}/events`,
        headers: bearer('owner'),
        payload: {
          addressJson: { line1: '9 MG Rd', city: 'Pune' },
          tzName: 'Asia/Kolkata',
          name: 'Walk-in Event',
          startsAt: '2030-09-01T10:00:00.000Z',
          endsAt: '2030-09-01T12:00:00.000Z',
          tiers: [{ name: 'Door', pricePaise: 50000, capacity: 3 }],
          questions: [{ label: 'T-shirt size', type: 'text', required: true }],
        },
      });
      expect(create.statusCode).toBe(200);
      eventId = (create.json() as { id: string }).id;
      const tierRows = (await db.execute(sql`
        select id from event_ticket_tiers where event_id = ${eventId} and deleted_at is null
      `)) as unknown as Array<{ id: string }>;
      tierId = tierRows[0]!.id;
      const qRows = (await db.execute(sql`
        select id from event_registration_questions where event_id = ${eventId}
      `)) as unknown as Array<{ id: string }>;
      questionId = qRows[0]!.id;
      await db.execute(sql`update events set status='published' where id = ${eventId}`);
    });

    const register = (payload: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url: `/v1/tenants/${tenantId}/events/${eventId}/registrations`,
        headers: bearer('owner'),
        payload,
      });

    it('records the attendee and never touches money', async () => {
      const res = await register({
        name: 'Walk-in Wendy',
        contact: '+919876500001',
        lines: [{ tierId, quantity: 1 }],
        answers: [{ questionId, answer: 'M' }],
      });
      expect(res.statusCode).toBe(201);
      const { bookingId } = res.json() as { bookingId: string };

      const rows = (await db.execute(sql`
        select channel, payment_method, status, total_paise, base_paise,
               customer_user_id, customer_name
          from bookings where id = ${bookingId}
      `)) as unknown as Array<Record<string, unknown>>;
      const b = rows[0]!;
      expect(b['channel']).toBe('walkin');
      expect(b['payment_method']).toBe('external');
      expect(b['status']).toBe('confirmed');
      expect(Number(b['total_paise'])).toBe(0);
      expect(Number(b['base_paise'])).toBe(0);
      expect(b['customer_user_id']).toBeNull();
      expect(b['customer_name']).toBe('Walk-in Wendy');

      // The money guarantee: payouts are computed from `payments`, so a
      // registration with no payment row can never reach a settlement.
      const pay = (await db.execute(sql`
        select count(*)::int as n from payments where booking_id = ${bookingId}
      `)) as unknown as Array<{ n: number }>;
      expect(pay[0]!.n).toBe(0);
    });

    it('stores the answers to required questions', async () => {
      const res = await register({
        name: 'Answering Anil',
        lines: [{ tierId, quantity: 1 }],
        answers: [{ questionId, answer: 'L' }],
      });
      expect(res.statusCode).toBe(201);
      const { bookingId } = res.json() as { bookingId: string };
      const rows = (await db.execute(sql`
        select answer from event_registration_answers where booking_id = ${bookingId}
      `)) as unknown as Array<{ answer: string }>;
      expect(rows[0]!.answer).toBe('L');
    });

    it('refuses a registration that skips a required question', async () => {
      const res = await register({
        name: 'Skipping Sam',
        lines: [{ tierId, quantity: 1 }],
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
    });

    it('counts against tier capacity like any other registration', async () => {
      // Tier capacity is 3; two seats are already taken by the tests above.
      const ok = await register({
        name: 'Last Seat Lata',
        lines: [{ tierId, quantity: 1 }],
        answers: [{ questionId, answer: 'S' }],
      });
      expect(ok.statusCode).toBe(201);

      const full = await register({
        name: 'Too Late Tom',
        lines: [{ tierId, quantity: 1 }],
        answers: [{ questionId, answer: 'S' }],
      });
      expect(full.statusCode).toBe(409);
      expect((full.json() as { error: { code: string } }).error.code).toBe('tier_sold_out');
    });

    it('shows up in the partner registrations list', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/tenants/${tenantId}/events/${eventId}/bookings`,
        headers: bearer('owner'),
      });
      expect(res.statusCode).toBe(200);
      const { rows } = res.json() as { rows: Array<{ customerName: string | null }> };
      expect(rows.some((r) => r.customerName === 'Walk-in Wendy')).toBe(true);
    });

    it('refuses registrations on an event that is not published', async () => {
      const draft = await app.inject({
        method: 'POST',
        url: `/v1/tenants/${tenantId}/events`,
        headers: bearer('owner'),
        payload: {
          addressJson: { line1: '9 MG Rd', city: 'Pune' },
          tzName: 'Asia/Kolkata',
          name: 'Unpublished',
          startsAt: '2030-09-02T10:00:00.000Z',
          endsAt: '2030-09-02T12:00:00.000Z',
          tiers: [{ name: 'GA', pricePaise: 0 }],
        },
      });
      const draftId = (draft.json() as { id: string }).id;
      const draftTier = (await db.execute(sql`
        select id from event_ticket_tiers where event_id = ${draftId} and deleted_at is null
      `)) as unknown as Array<{ id: string }>;

      const res = await app.inject({
        method: 'POST',
        url: `/v1/tenants/${tenantId}/events/${draftId}/registrations`,
        headers: bearer('owner'),
        payload: { name: 'Nope', lines: [{ tierId: draftTier[0]!.id, quantity: 1 }] },
      });
      expect(res.statusCode).toBe(409);
      expect((res.json() as { error: { code: string } }).error.code).toBe('event_not_published');
    });
  });

  describe('ending and archiving', () => {
    /** Fresh event per test; most of these are one-way state changes. */
    async function makeEvent(name: string): Promise<string> {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/tenants/${tenantId}/events`,
        headers: bearer('owner'),
        payload: {
          addressJson: { line1: '5 MG Rd', city: 'Pune' },
          tzName: 'Asia/Kolkata',
          name,
          startsAt: '2030-08-01T10:00:00.000Z',
          endsAt: '2030-08-01T12:00:00.000Z',
          tiers: [{ name: 'GA', pricePaise: 0 }],
        },
      });
      expect(res.statusCode).toBe(200);
      return (res.json() as { id: string }).id;
    }

    const post = (id: string, action: string) =>
      app.inject({
        method: 'POST',
        url: `/v1/tenants/${tenantId}/events/${id}/${action}`,
        headers: bearer('owner'),
      });

    it('ends a published event, and it leaves the public listing', async () => {
      const id = await makeEvent('To End');
      await db.execute(sql`update events set status='published' where id = ${id}`);

      const res = await post(id, 'complete');
      expect(res.statusCode).toBe(200);
      expect((res.json() as { status: string }).status).toBe('completed');

      // Consumers gate on status='published', so it is gone from the browse
      // feed the moment it completes.
      const browse = await app.inject({ method: 'GET', url: '/v1/consumer/events' });
      expect(browse.statusCode).toBe(200);
      const { rows } = browse.json() as { rows: Array<{ id: string }> };
      expect(rows.some((e) => e.id === id)).toBe(false);
    });

    it('refuses to end anything that is not published', async () => {
      const id = await makeEvent('Still Draft');
      const res = await post(id, 'complete');
      expect(res.statusCode).toBe(409);
      expect((res.json() as { error: { code: string } }).error.code).toBe('event_not_published');
    });

    it('writes an audit row for the ending', async () => {
      const id = await makeEvent('Audited End');
      await db.execute(sql`update events set status='published' where id = ${id}`);
      await post(id, 'complete');
      const rows = (await db.execute(sql`
        select action from audit_log
         where entity_id = ${id} and action = 'event.completed'
      `)) as unknown as Array<{ action: string }>;
      expect(rows.length).toBe(1);
    });

    it('archives a draft and hides it from the default list', async () => {
      const id = await makeEvent('To Archive');
      expect((await post(id, 'archive')).statusCode).toBe(200);

      const listed = async (query: string) => {
        const res = await app.inject({
          method: 'GET',
          url: `/v1/tenants/${tenantId}/events${query}`,
          headers: bearer('owner'),
        });
        return (res.json() as Array<{ id: string }>).some((e) => e.id === id);
      };

      expect(await listed('')).toBe(false);
      expect(await listed('?archived=true')).toBe(true);
      expect(await listed('?archived=all')).toBe(true);
    });

    it('unarchives back onto the default list', async () => {
      const id = await makeEvent('Round Trip');
      await post(id, 'archive');
      expect((await post(id, 'unarchive')).statusCode).toBe(200);
      const res = await app.inject({
        method: 'GET',
        url: `/v1/tenants/${tenantId}/events`,
        headers: bearer('owner'),
      });
      expect((res.json() as Array<{ id: string }>).some((e) => e.id === id)).toBe(true);
    });

    it('refuses to archive a live event, so nothing still selling can be hidden', async () => {
      const id = await makeEvent('Live One');
      await db.execute(sql`update events set status='published' where id = ${id}`);
      const res = await post(id, 'archive');
      expect(res.statusCode).toBe(409);
      expect((res.json() as { error: { code: string } }).error.code).toBe('event_not_archivable');
    });

    it('archives an event once it has been ended', async () => {
      const id = await makeEvent('End Then Shelve');
      await db.execute(sql`update events set status='published' where id = ${id}`);
      await post(id, 'complete');
      expect((await post(id, 'archive')).statusCode).toBe(200);
    });

    it('is idempotent — archiving twice is not an error', async () => {
      const id = await makeEvent('Twice');
      expect((await post(id, 'archive')).statusCode).toBe(200);
      expect((await post(id, 'archive')).statusCode).toBe(200);
    });

    it('reopens an event ended by mistake, while its window is still open', async () => {
      const id = await makeEvent('Oops Ended');
      await db.execute(sql`update events set status='published' where id = ${id}`);
      await post(id, 'complete');

      const res = await post(id, 'reopen');
      expect(res.statusCode).toBe(200);
      expect((res.json() as { status: string }).status).toBe('published');

      // Back on sale: the public browse feed lists it again.
      const browse = await app.inject({ method: 'GET', url: '/v1/consumer/events' });
      const { rows } = browse.json() as { rows: Array<{ id: string }> };
      expect(rows.some((e) => e.id === id)).toBe(true);
    });

    it('refuses to reopen an event whose end time has passed', async () => {
      const id = await makeEvent('Long Over');
      await db.execute(sql`update events set status='published' where id = ${id}`);
      await post(id, 'complete');
      // Drag the window into the past — a reopened event would be invisible to
      // consumers anyway, since their queries require ends_at >= now().
      await db.execute(sql`
        update events set starts_at = now() - interval '3 hours',
                          ends_at   = now() - interval '1 hour'
         where id = ${id}
      `);

      const res = await post(id, 'reopen');
      expect(res.statusCode).toBe(409);
      expect((res.json() as { error: { code: string } }).error.code).toBe('event_window_passed');
    });

    it('refuses to reopen anything that was not ended', async () => {
      const id = await makeEvent('Never Ended');
      await db.execute(sql`update events set status='published' where id = ${id}`);
      const res = await post(id, 'reopen');
      expect(res.statusCode).toBe(409);
      expect((res.json() as { error: { code: string } }).error.code).toBe('event_not_completed');
    });

    it('reopening also takes the event back off the archive shelf', async () => {
      const id = await makeEvent('Ended Then Shelved');
      await db.execute(sql`update events set status='published' where id = ${id}`);
      await post(id, 'complete');
      await post(id, 'archive');

      expect((await post(id, 'reopen')).statusCode).toBe(200);
      // A published event is never archived, so the shelf flag has to clear.
      const rows = (await db.execute(sql`
        select status, archived_at from events where id = ${id}
      `)) as unknown as Array<{ status: string; archived_at: string | null }>;
      expect(rows[0]!.status).toBe('published');
      expect(rows[0]!.archived_at).toBeNull();
    });

    it('refuses to edit an event once it has ended', async () => {
      const id = await makeEvent('No Edits After End');
      await db.execute(sql`update events set status='published' where id = ${id}`);
      await post(id, 'complete');
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/tenants/${tenantId}/events/${id}`,
        headers: bearer('owner'),
        payload: { name: 'Renamed' },
      });
      expect(res.statusCode).toBe(409);
    });
  });

  describe('live settings on a published event', () => {
    let eventId: string;
    let cappedTierId: string;
    let uncappedTierId: string;

    beforeAll(async () => {
      const create = await app.inject({
        method: 'POST',
        url: `/v1/tenants/${tenantId}/events`,
        headers: bearer('owner'),
        payload: {
          addressJson: { line1: '5 MG Rd', city: 'Pune' },
          tzName: 'Asia/Kolkata',
          name: 'Live Settings Event',
          startsAt: '2030-07-01T10:00:00.000Z',
          endsAt: '2030-07-01T12:00:00.000Z',
          maxPerUser: 4,
          postBookingRedirect: { url: 'https://forms.gle/at-create', forced: true },
          tiers: [
            { name: 'Capped', pricePaise: 0, capacity: 10 },
            { name: 'Uncapped', pricePaise: 0 },
          ],
        },
      });
      expect(create.statusCode).toBe(200);
      expect((create.json() as { postBookingRedirect: unknown }).postBookingRedirect).toEqual({
        url: 'https://forms.gle/at-create',
        description: null,
        forced: true,
      });
      eventId = (create.json() as { id: string }).id;
      const tierRows = (await db.execute(sql`
        select id, name from event_ticket_tiers where event_id = ${eventId} and deleted_at is null
      `)) as unknown as Array<{ id: string; name: string }>;
      cappedTierId = tierRows.find((t) => t.name === 'Capped')!.id;
      uncappedTierId = tierRows.find((t) => t.name === 'Uncapped')!.id;
      await db.execute(sql`update events set status='published' where id = ${eventId}`);
    });

    it('allows changing maxPerUser and raising tier capacity', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/tenants/${tenantId}/events/${eventId}`,
        headers: bearer('owner'),
        payload: { maxPerUser: 2, tierCapacities: [{ tierId: cappedTierId, capacity: 25 }] },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { maxPerUser: number | null }).maxPerUser).toBe(2);

      const detail = await app.inject({
        method: 'GET',
        url: `/v1/tenants/${tenantId}/events/${eventId}`,
        headers: bearer('owner'),
      });
      const tiers = (detail.json() as { tiers: Array<{ id: string; capacity: number | null }> })
        .tiers;
      expect(tiers.find((t) => t.id === cappedTierId)!.capacity).toBe(25);

      // Lowering a numeric cap (25 → 10) is a decrease and must be rejected.
      const lower = await app.inject({
        method: 'PATCH',
        url: `/v1/tenants/${tenantId}/events/${eventId}`,
        headers: bearer('owner'),
        payload: { tierCapacities: [{ tierId: cappedTierId, capacity: 10 }] },
      });
      expect(lower.statusCode).toBe(400);
      expect(lower.json().error.code).toBe('event_capacity_decrease');
    });

    it('allows lifting a capped tier to unlimited and clearing maxPerUser', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/tenants/${tenantId}/events/${eventId}`,
        headers: bearer('owner'),
        payload: { maxPerUser: null, tierCapacities: [{ tierId: cappedTierId, capacity: null }] },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { maxPerUser: number | null }).maxPerUser).toBeNull();

      const detail = await app.inject({
        method: 'GET',
        url: `/v1/tenants/${tenantId}/events/${eventId}`,
        headers: bearer('owner'),
      });
      const tiers = (detail.json() as { tiers: Array<{ id: string; capacity: number | null }> })
        .tiers;
      expect(tiers.find((t) => t.id === cappedTierId)!.capacity).toBeNull();
    });

    it('rejects capping a now-unlimited tier (a decrease) with event_capacity_decrease', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/tenants/${tenantId}/events/${eventId}`,
        headers: bearer('owner'),
        payload: { tierCapacities: [{ tierId: uncappedTierId, capacity: 5 }] },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('event_capacity_decrease');
    });

    it('sets, rewrites, and clears the post-booking redirect while live', async () => {
      const set = await app.inject({
        method: 'PATCH',
        url: `/v1/tenants/${tenantId}/events/${eventId}`,
        headers: bearer('owner'),
        payload: {
          postBookingRedirect: {
            url: 'https://forms.gle/roster',
            description: '  Send us your roster  ',
            forced: true,
          },
        },
      });
      expect(set.statusCode).toBe(200);
      expect((set.json() as { postBookingRedirect: unknown }).postBookingRedirect).toEqual({
        url: 'https://forms.gle/roster',
        description: 'Send us your roster',
        forced: true,
      });

      // Omitted optionals fall back to their defaults, not the previous values.
      const rewrite = await app.inject({
        method: 'PATCH',
        url: `/v1/tenants/${tenantId}/events/${eventId}`,
        headers: bearer('owner'),
        payload: { postBookingRedirect: { url: 'https://chat.whatsapp.com/ABCdef' } },
      });
      expect(rewrite.statusCode).toBe(200);
      expect((rewrite.json() as { postBookingRedirect: unknown }).postBookingRedirect).toEqual({
        url: 'https://chat.whatsapp.com/ABCdef',
        description: null,
        forced: false,
      });

      const cleared = await app.inject({
        method: 'PATCH',
        url: `/v1/tenants/${tenantId}/events/${eventId}`,
        headers: bearer('owner'),
        payload: { postBookingRedirect: null },
      });
      expect(cleared.statusCode).toBe(200);
      expect(
        (cleared.json() as { postBookingRedirect: unknown }).postBookingRedirect,
      ).toBeNull();
    });

    it('rejects a non-http(s) redirect URL', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/tenants/${tenantId}/events/${eventId}`,
        headers: bearer('owner'),
        payload: { postBookingRedirect: { url: 'javascript:alert(1)' } },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('bad_request');
    });

    it('rejects any other field on a published event with event_not_draft', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/tenants/${tenantId}/events/${eventId}`,
        headers: bearer('owner'),
        payload: { name: 'Sneaky rename', maxPerUser: 3 },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('event_not_draft');
    });
  });
});
