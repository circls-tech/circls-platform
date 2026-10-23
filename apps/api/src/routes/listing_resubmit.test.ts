import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// A listing Circls rejected is fixed in place and sent again: edits open up
// as on a draft, "submit" takes it rejected → pending_review, it stays off the
// consumer site until approved, and the admin queue flags it as resubmitted.
vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      owner: { uid: 'fbuid_lrowner', email: 'lrowner@x.com', email_verified: true },
      manager: { uid: 'fbuid_lrmanager', email: 'lrmanager@x.com', email_verified: true },
      staff: { uid: 'fbuid_lrstaff', email: 'lrstaff@x.com', email_verified: true },
    };
    const u = map[token];
    if (!u) throw new Error('bad token');
    return u;
  }),
}));

const { closeDb, db } = await import('../db/client.js');
const { arenas, auditLog, events, memberships, tenantMembers, venues } = await import('../db/schema/index.js');
const { buildServer } = await import('../server.js');
const { approveListing, getListingDetail, listListingsForReview, rejectListing } = await import(
  '../services/listing_service.js'
);

const runIntegration = Boolean(process.env.RUN_INTEGRATION);
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

interface ErrorBody {
  error: { code: string; details?: { missing?: string[] } };
}

describe.skipIf(!runIntegration)('resubmitting rejected listings', () => {
  let app: FastifyInstance;
  let tenantId: string;
  let venueId: string;
  let ownerId: string;

  const call = (
    token: string,
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    payload?: object,
  ) => app.inject({ method, url, headers: bearer(token), ...(payload ? { payload } : {}) });

  /** Circls rejects a pending listing, with a reason. */
  const reject = (type: 'venue' | 'arena' | 'event' | 'membership', id: string, reason?: string) =>
    rejectListing({ type, id, actorUserId: ownerId, ...(reason ? { reason } : {}) });

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
    const t = await call('owner', 'POST', '/v1/tenants', {
      name: 'Resubmit Co',
      slug: `lrco-${Date.now()}`,
      country: 'India',
      acceptTerms: true,
    });
    expect(t.statusCode).toBe(200);
    tenantId = t.json().id;
    const v = await call('owner', 'POST', `/v1/tenants/${tenantId}/venues`, { name: 'Resubmit Venue' });
    expect(v.statusCode).toBe(200);
    venueId = v.json().id;
    // The venue other listings hang off is live, so only the listing under
    // test decides what consumers see.
    await approveListing({ type: 'venue', id: venueId, actorUserId: (await me('owner')) });
    ownerId = await me('owner');

    const managerId = await me('manager');
    const staffId = await me('staff');
    await db.insert(tenantMembers).values([
      { userId: managerId, tenantId, role: 'manager' },
      { userId: staffId, tenantId, role: 'staff' },
    ]);
  });

  async function me(token: string): Promise<string> {
    const res = await call(token, 'GET', '/v1/me');
    expect(res.statusCode).toBe(200);
    return (res.json() as { id: string }).id;
  }

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  async function pendingEvent(name: string): Promise<string> {
    const start = new Date(Date.now() + 9 * 86_400_000);
    const created = await call('owner', 'POST', `/v1/tenants/${tenantId}/events`, {
      name,
      addressJson: { line1: '5 MG Rd', city: 'Pune' },
      tzName: 'Asia/Kolkata',
      startsAt: start.toISOString(),
      endsAt: new Date(start.getTime() + 2 * 3_600_000).toISOString(),
      tiers: [{ name: 'General', pricePaise: 10000 }],
    });
    expect(created.statusCode).toBe(200);
    const ev = created.json() as { id: string; status: string };
    if (ev.status === 'draft') {
      expect((await call('owner', 'POST', `/v1/tenants/${tenantId}/events/${ev.id}/publish`)).statusCode).toBe(200);
    }
    return ev.id;
  }

  it('a rejected event is edited like a draft, sent again, and stays hidden until approved', async () => {
    const id = await pendingEvent('Rejected Rally');
    await reject('event', id, 'The cover photo shows another brand.');

    // Locked no more: the partner sees why and fixes it in place.
    const detail = await call('owner', 'GET', `/v1/tenants/${tenantId}/events/${id}`);
    expect(detail.statusCode).toBe(200);
    const body = detail.json() as { status: string; missing: string[]; rejection: { reason: string } | null };
    expect(body.status).toBe('rejected');
    expect(body.missing).toEqual([]);
    expect(body.rejection?.reason).toBe('The cover photo shows another brand.');

    const edited = await call('owner', 'PATCH', `/v1/tenants/${tenantId}/events/${id}`, {
      name: 'Rally, fixed',
      tiers: [{ name: 'General', pricePaise: 12000 }],
    });
    expect(edited.statusCode).toBe(200);
    expect((edited.json() as { status: string; name: string }).status).toBe('rejected');
    expect((await app.inject({ method: 'GET', url: `/v1/consumer/events/${id}` })).statusCode).toBe(404);

    const sent = await call('owner', 'POST', `/v1/tenants/${tenantId}/events/${id}/publish`);
    expect(sent.statusCode).toBe(200);
    expect((sent.json() as { status: string }).status).toBe('pending_review');
    const [audit] = await db
      .select({ before: auditLog.before, after: auditLog.after })
      .from(auditLog)
      .where(and(eq(auditLog.entityId, id), eq(auditLog.action, 'event.submitted_for_review')))
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    expect(audit?.before).toEqual({ status: 'rejected' });
    expect(audit?.after).toEqual({ status: 'pending_review' });
    // Still not public: in review is not approved.
    expect((await app.inject({ method: 'GET', url: `/v1/consumer/events/${id}` })).statusCode).toBe(404);

    // Back in the queue like any pending item, flagged, with what was asked.
    const queue = await listListingsForReview({ type: 'event' });
    const row = queue.find((r) => r.id === id);
    expect(row?.resubmitted).toBe(true);
    const adminDetail = await getListingDetail('event', id);
    expect(adminDetail?.lastRejection?.reason).toBe('The cover photo shows another brand.');
    expect(adminDetail?.name).toBe('Rally, fixed');

    await approveListing({ type: 'event', id, actorUserId: ownerId });
    expect((await app.inject({ method: 'GET', url: `/v1/consumer/events/${id}` })).statusCode).toBe(200);
  });

  it('a first submission is not flagged as a resubmission', async () => {
    const id = await pendingEvent('Fresh Fete');
    const row = (await listListingsForReview({ type: 'event' })).find((r) => r.id === id);
    expect(row).toBeDefined();
    expect(row?.resubmitted).toBeUndefined();
  });

  it('pending, live and cancelled events still refuse a resubmission and full edits', async () => {
    const id = await pendingEvent('Pending Party');
    const again = await call('owner', 'POST', `/v1/tenants/${tenantId}/events/${id}/publish`);
    expect(again.statusCode).toBe(409);
    expect((again.json() as ErrorBody).error.code).toBe('event_not_draft');
    const edit = await call('owner', 'PATCH', `/v1/tenants/${tenantId}/events/${id}`, { name: 'Sneaky' });
    expect(edit.statusCode).toBe(409);
  });

  it('a rejected event still has to be complete to go again', async () => {
    const id = await pendingEvent('Tierless Tour');
    await reject('event', id);
    // Strip it back to a gap, then try to send it.
    await db.update(events).set({ startsAt: null, endsAt: null }).where(eq(events.id, id));
    const refused = await call('owner', 'POST', `/v1/tenants/${tenantId}/events/${id}/publish`);
    expect(refused.statusCode).toBe(409);
    expect((refused.json() as ErrorBody).error.code).toBe('event_incomplete');
    expect((refused.json() as ErrorBody).error.details?.missing).toEqual(['dates']);
    // No reason given: the partner sees the rejection, without one.
    const detail = (await call('owner', 'GET', `/v1/tenants/${tenantId}/events/${id}`)).json() as {
      rejection: { reason: string | null; rejectedAt: string } | null;
    };
    expect(detail.rejection?.reason).toBeNull();
    expect(detail.rejection?.rejectedAt).toBeTruthy();
  });

  it('a rejected series goes back to review as one unit', async () => {
    const start = new Date(Date.now() + 20 * 86_400_000);
    const occ = (days: number) => ({
      startsAt: new Date(start.getTime() + days * 86_400_000).toISOString(),
      endsAt: new Date(start.getTime() + days * 86_400_000 + 3_600_000).toISOString(),
    });
    const created = await call('owner', 'POST', `/v1/tenants/${tenantId}/events`, {
      name: 'Weekly Rejects',
      addressJson: { line1: '5 MG Rd', city: 'Pune' },
      tzName: 'Asia/Kolkata',
      tiers: [{ name: 'General', pricePaise: 0 }],
      occurrences: [occ(0), occ(7), occ(14)],
    });
    expect(created.statusCode).toBe(200);
    const { seriesId, events: dates } = created.json() as { seriesId: string; events: { id: string; status: string }[] };
    if (dates[0]!.status === 'draft') {
      expect((await call('owner', 'POST', `/v1/tenants/${tenantId}/event-series/${seriesId}/publish`)).statusCode).toBe(200);
    }
    // Rejecting one date rejects the series.
    await reject('event', dates[0]!.id, 'Wrong city.');
    const sent = await call('owner', 'POST', `/v1/tenants/${tenantId}/event-series/${seriesId}/publish`);
    expect(sent.statusCode).toBe(200);
    expect((sent.json() as { count: number }).count).toBe(3);
    const rows = await db.select({ status: events.status }).from(events).where(eq(events.seriesId, seriesId));
    expect(rows.every((r) => r.status === 'pending_review')).toBe(true);

    // Sending one date again from its own page takes the whole series with it,
    // so an approval can't leave the other dates rejected.
    await reject('event', dates[1]!.id, 'Still the wrong city.');
    const one = await call('owner', 'POST', `/v1/tenants/${tenantId}/events/${dates[2]!.id}/publish`);
    expect(one.statusCode).toBe(200);
    expect((one.json() as { id: string; status: string })).toMatchObject({ id: dates[2]!.id, status: 'pending_review' });
    const after = await db.select({ status: events.status }).from(events).where(eq(events.seriesId, seriesId));
    expect(after.every((r) => r.status === 'pending_review')).toBe(true);
  });

  it('submitting an archived rejected event records that it left the archive', async () => {
    const id = await pendingEvent('Shelved Social');
    await reject('event', id);
    expect((await call('owner', 'POST', `/v1/tenants/${tenantId}/events/${id}/archive`)).statusCode).toBe(200);
    expect((await call('owner', 'POST', `/v1/tenants/${tenantId}/events/${id}/publish`)).statusCode).toBe(200);
    const [row] = await db.select({ archivedAt: events.archivedAt }).from(events).where(eq(events.id, id));
    expect(row?.archivedAt).toBeNull();
    const [audit] = await db
      .select({ before: auditLog.before, after: auditLog.after })
      .from(auditLog)
      .where(and(eq(auditLog.entityId, id), eq(auditLog.action, 'event.submitted_for_review')))
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    expect(audit?.before).toEqual({ status: 'rejected', archived: true });
    expect(audit?.after).toEqual({ status: 'pending_review', archived: false });
  });

  it('a rejected venue is sent again; reopening still does not get round review', async () => {
    const created = await call('owner', 'POST', `/v1/tenants/${tenantId}/venues`, { name: 'Rejected Rink' });
    const id = (created.json() as { id: string }).id;
    await reject('venue', id, 'Add the street address.');

    const detail = (await call('owner', 'GET', `/v1/venues/${id}`)).json() as {
      status: string;
      rejection: { reason: string } | null;
    };
    expect(detail.rejection?.reason).toBe('Add the street address.');
    // Closing and reopening comes back rejected, as before.
    await call('owner', 'POST', `/v1/venues/${id}/close`);
    expect((await call('owner', 'POST', `/v1/venues/${id}/reopen`)).json().status).toBe('rejected');

    expect(
      (await call('owner', 'PATCH', `/v1/venues/${id}`, { addressLine1: '1 Rink Rd', city: 'Pune' })).statusCode,
    ).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/v1/consumer/venues/${id}` })).statusCode).toBe(404);

    // Staff can't send a listing to review; a Manager can.
    expect((await call('staff', 'POST', `/v1/venues/${id}/submit`)).statusCode).toBe(403);
    const sent = await call('manager', 'POST', `/v1/venues/${id}/submit`);
    expect(sent.statusCode).toBe(200);
    expect((sent.json() as { status: string }).status).toBe('pending_review');
    expect((await app.inject({ method: 'GET', url: `/v1/consumer/venues/${id}` })).statusCode).toBe(404);
    expect((await listListingsForReview({ type: 'venue' })).find((r) => r.id === id)?.resubmitted).toBe(true);

    // In review, there is nothing to send.
    const twice = await call('owner', 'POST', `/v1/venues/${id}/submit`);
    expect(twice.statusCode).toBe(409);
    expect((twice.json() as ErrorBody).error.code).toBe('venue_not_draft');
  });

  it('a rejected plan opens for edits and is sent again', async () => {
    const created = await call('owner', 'POST', `/v1/tenants/${tenantId}/memberships`, {
      name: 'Rejected Gold',
      pricePaise: 50000,
      durationDays: 30,
    });
    expect(created.statusCode).toBe(200);
    const id = (created.json() as { id: string }).id;
    const [row] = await db.select({ status: memberships.status }).from(memberships).where(eq(memberships.id, id));
    expect(row?.status).toBe('pending_review');
    await reject('membership', id, 'Terms are missing.');

    // Staff can't touch the plan; the owner can.
    expect((await call('staff', 'PATCH', `/v1/tenants/${tenantId}/memberships/${id}`, { terms: 'x' })).statusCode).toBe(403);
    const edited = await call('owner', 'PATCH', `/v1/tenants/${tenantId}/memberships/${id}`, {
      terms: 'No refunds after 7 days.',
    });
    expect(edited.statusCode).toBe(200);
    const detail = (await call('owner', 'GET', `/v1/tenants/${tenantId}/memberships/${id}`)).json() as {
      status: string;
      missing: string[];
      rejection: { reason: string } | null;
    };
    expect(detail.status).toBe('rejected');
    expect(detail.missing).toEqual([]);
    expect(detail.rejection?.reason).toBe('Terms are missing.');
    expect((await app.inject({ method: 'GET', url: `/v1/consumer/memberships/${id}` })).statusCode).toBe(404);

    expect((await call('staff', 'POST', `/v1/tenants/${tenantId}/memberships/${id}/submit`)).statusCode).toBe(403);
    const sent = await call('owner', 'POST', `/v1/tenants/${tenantId}/memberships/${id}/submit`);
    expect(sent.statusCode).toBe(200);
    expect((sent.json() as { status: string }).status).toBe('pending_review');
    expect((await listListingsForReview({ type: 'membership' })).find((r) => r.id === id)?.resubmitted).toBe(true);
    expect((await app.inject({ method: 'GET', url: `/v1/consumer/memberships/${id}` })).statusCode).toBe(404);
  });

  it('a rejected arena opens its reviewed details, and only then', async () => {
    const created = await call('owner', 'POST', `/v1/venues/${venueId}/arenas`, { name: 'Court X', sport: 'tennis' });
    expect(created.statusCode).toBe(200);
    const id = (created.json() as { id: string }).id;

    // A client sending the whole arena, unchanged, with new QR rules is fine.
    const whole = await call('owner', 'PATCH', `/v1/arenas/${id}`, {
      name: 'Court X',
      sport: 'tennis',
      tags: [],
      qrTicketConfig: { enabled: true, multiUse: false },
    });
    expect(whole.statusCode).toBe(200);

    // In review: the details Circls is looking at can't change underneath it.
    const early = await call('owner', 'PATCH', `/v1/arenas/${id}`, { name: 'Court Y' });
    expect(early.statusCode).toBe(409);
    expect((early.json() as ErrorBody).error.code).toBe('arena_not_editable');
    // …and there is nothing to resubmit.
    expect((await call('owner', 'POST', `/v1/arenas/${id}/submit`)).statusCode).toBe(409);

    await reject('arena', id, 'This is a badminton court.');
    const detail = (await call('owner', 'GET', `/v1/arenas/${id}`)).json() as {
      rejection: { reason: string } | null;
    };
    expect(detail.rejection?.reason).toBe('This is a badminton court.');

    expect((await call('staff', 'PATCH', `/v1/arenas/${id}`, { sport: 'badminton' })).statusCode).toBe(403);
    const edited = await call('manager', 'PATCH', `/v1/arenas/${id}`, { sport: 'badminton', capacity: 4 });
    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toMatchObject({ sport: 'badminton', capacity: 4, status: 'rejected' });
    // A cleared sport falls back to the tags', as on create.
    const cleared = await call('owner', 'PATCH', `/v1/arenas/${id}`, { sport: null, tags: ['badminton'] });
    expect(cleared.statusCode).toBe(200);
    expect((cleared.json() as { sport: string | null }).sport).toBe('badminton');

    expect((await call('staff', 'POST', `/v1/arenas/${id}/submit`)).statusCode).toBe(403);
    const sent = await call('manager', 'POST', `/v1/arenas/${id}/submit`);
    expect(sent.statusCode).toBe(200);
    expect((sent.json() as { status: string }).status).toBe('pending_review');
    const [row] = await db.select({ status: arenas.status }).from(arenas).where(eq(arenas.id, id));
    expect(row?.status).toBe('pending_review');
    expect((await listListingsForReview({ type: 'arena' })).find((r) => r.id === id)?.resubmitted).toBe(true);

    // QR rules stay editable in any state.
    const qr = await call('owner', 'PATCH', `/v1/arenas/${id}`, {
      qrTicketConfig: { enabled: true, multiUse: false },
    });
    expect(qr.statusCode).toBe(200);
  });

  it('a live venue is not resubmittable', async () => {
    const [v] = await db.select({ status: venues.status }).from(venues).where(eq(venues.id, venueId));
    expect(v?.status).toBe('active');
    expect((await call('owner', 'POST', `/v1/venues/${venueId}/submit`)).statusCode).toBe(409);
  });
});
