import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Who may do what on a partner tenant: the team-management hierarchy, and the
// capability each write route asks for. Integration-gated (needs Postgres).
vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      owner: { uid: 'fbuid_rpowner', email: 'rpowner@x.com', email_verified: true },
      owner2: { uid: 'fbuid_rpowner2', email: 'rpowner2@x.com', email_verified: true },
      manager: { uid: 'fbuid_rpmanager', email: 'rpmanager@x.com', email_verified: true },
      staff: { uid: 'fbuid_rpstaff', email: 'rpstaff@x.com', email_verified: true },
      readonly: { uid: 'fbuid_rpreadonly', email: 'rpreadonly@x.com', email_verified: true },
    };
    const u = map[token];
    if (!u) throw new Error('bad token');
    return u;
  }),
}));

const { closeDb, db } = await import('../db/client.js');
const { tenantMembers } = await import('../db/schema/index.js');
const { buildServer } = await import('../server.js');

const runIntegration = Boolean(process.env.RUN_INTEGRATION);
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const withKey = (t: string) => ({ ...bearer(t), 'idempotency-key': `rp-${crypto.randomUUID()}` });
const uuid = () => crypto.randomUUID();
const PERMISSION_CODES = ['forbidden_capability', 'tenant_forbidden'];

/** The error code of a response, or null for a success (204s have no body). */
function errorCode(res: { body: string }): string | null {
  if (!res.body) return null;
  return (JSON.parse(res.body) as { error?: { code?: string } }).error?.code ?? null;
}

/** A YYYY-MM-DD at least `minDaysOut` days ahead that falls on `dow` (0=Sun). */
function futureWeekday(minDaysOut: number, dow: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + minDaysOut);
  while (d.getUTCDay() !== dow) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

describe.skipIf(!runIntegration)('partner role permissions', () => {
  let app: FastifyInstance;
  let tenantId: string;
  let venueId: string;
  let arenaId: string;
  let slotId: string;
  let eventId: string;
  let membershipId: string;
  const userIds: Record<string, string> = {};

  const call = (
    token: string,
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    payload?: object,
    headers: Record<string, string> = bearer(token),
  ) => app.inject({ method, url, headers, ...(payload ? { payload } : {}) });

  async function roleOf(token: string): Promise<string | undefined> {
    const res = await call('owner', 'GET', `/v1/tenants/${tenantId}/members`);
    return (res.json() as { userId: string; role: string }[]).find((m) => m.userId === userIds[token])
      ?.role;
  }

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();

    const t = await call('owner', 'POST', '/v1/tenants', {
      name: 'Roles Co',
      slug: `rpco-${Date.now()}`,
      country: 'India',
      acceptTerms: true,
    });
    tenantId = t.json().id;
    venueId = (await call('owner', 'POST', `/v1/tenants/${tenantId}/venues`, { name: 'Roles Venue' })).json()
      .id;
    arenaId = (await call('owner', 'POST', `/v1/venues/${venueId}/arenas`, { name: 'Court A' })).json().id;

    // One open slot to book, hold and re-price.
    const day = futureWeekday(14, 3);
    await call(
      'owner',
      'POST',
      `/v1/arenas/${arenaId}/slots/release`,
      {
        startDate: day,
        endDate: day,
        quantizationMin: 60,
        cells: [{ dayOfWeek: 3, startTimeMin: 600, durationMin: 60, price: 50000 }],
      },
      withKey('owner'),
    );
    const slots = (
      await call('owner', 'GET', `/v1/arenas/${arenaId}/slots?from=${day}T00:00:00Z&to=${day}T23:59:59Z`)
    ).json() as { id: string; status: string }[];
    slotId = slots.find((s) => s.status === 'open')!.id;

    eventId = (
      await call('owner', 'POST', `/v1/tenants/${tenantId}/events`, {
        addressJson: { line1: '5 MG Rd', city: 'Pune' },
        tzName: 'Asia/Kolkata',
        name: 'Roles Meetup',
        startsAt: '2031-05-01T10:00:00.000Z',
        endsAt: '2031-05-01T12:00:00.000Z',
        tiers: [{ name: 'General', pricePaise: 0 }],
      })
    ).json().id;
    membershipId = (
      await call('owner', 'POST', `/v1/tenants/${tenantId}/memberships`, {
        name: 'Gold',
        pricePaise: 0,
        durationDays: 30,
      })
    ).json().id;

    for (const token of ['owner', 'owner2', 'manager', 'staff', 'readonly']) {
      const me = await call(token, 'GET', '/v1/me');
      expect(me.statusCode).toBe(200);
      userIds[token] = (me.json() as { id: string }).id;
    }
    await db.insert(tenantMembers).values([
      { userId: userIds.owner2!, tenantId, role: 'owner' },
      { userId: userIds.manager!, tenantId, role: 'manager' },
      { userId: userIds.staff!, tenantId, role: 'staff' },
      { userId: userIds.readonly!, tenantId, role: 'readonly' },
    ]);
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  describe('team hierarchy', () => {
    const setRole = (token: string, target: string, role: string) =>
      call(token, 'PATCH', `/v1/tenants/${tenantId}/members/${userIds[target]}`, { role });

    it("won't let a Manager make anyone an Owner, themselves included", async () => {
      for (const target of ['manager', 'staff']) {
        const res = await setRole('manager', target, 'owner');
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe('role_above_yours');
      }
      expect(await roleOf('manager')).toBe('manager');
      expect(await roleOf('staff')).toBe('staff');
    });

    it("won't let a Manager change or remove an Owner", async () => {
      const demote = await setRole('manager', 'owner2', 'staff');
      expect(demote.statusCode).toBe(403);
      expect(demote.json().error.code).toBe('role_above_yours');

      const remove = await call('manager', 'DELETE', `/v1/tenants/${tenantId}/members/${userIds.owner2}`);
      expect(remove.statusCode).toBe(403);
      expect(remove.json().error.code).toBe('role_above_yours');
      expect(await roleOf('owner2')).toBe('owner');
    });

    it('lets a Manager manage roles up to their own', async () => {
      expect((await setRole('manager', 'staff', 'manager')).statusCode).toBe(200);
      expect((await setRole('manager', 'staff', 'staff')).statusCode).toBe(200);
      expect(await roleOf('staff')).toBe('staff');
    });

    it('lets an Owner make and unmake Owners', async () => {
      expect((await setRole('owner', 'staff', 'owner')).statusCode).toBe(200);
      expect((await setRole('owner', 'staff', 'staff')).statusCode).toBe(200);
    });

    it("won't let a Manager invite an Owner, or re-send an Owner's invitation", async () => {
      const invite = (token: string, role: string) =>
        call(token, 'POST', `/v1/tenants/${tenantId}/invitations`, {
          email: `rp-${role}-${uuid()}@x.test`,
          role,
        });

      const asOwner = await invite('manager', 'owner');
      expect(asOwner.statusCode).toBe(403);
      expect(asOwner.json().error.code).toBe('role_above_yours');
      expect((await invite('manager', 'manager')).statusCode).toBe(201);

      const ownerInvite = await invite('owner', 'owner');
      expect(ownerInvite.statusCode).toBe(201);
      const resend = (token: string) =>
        call(
          token,
          'POST',
          `/v1/tenants/${tenantId}/invitations/${ownerInvite.json().invitation.id}/resend`,
        );
      const byManager = await resend('manager');
      expect(byManager.statusCode).toBe(403);
      expect(byManager.json().error.code).toBe('role_above_yours');
      expect((await resend('owner')).statusCode).toBe(200);
    });
  });

  describe('write routes', () => {
    interface Case {
      name: string;
      method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
      url: () => string;
      payload?: () => object;
      idempotent?: boolean;
      cap: string;
      /** Whether Staff hold `cap` (Owner and Manager always do; Read-only never). */
      staff: boolean;
    }

    const eventUrl = (path = '') => `/v1/tenants/${tenantId}/events/${eventId}${path}`;
    const newEvent = () => ({
      tzName: 'Asia/Kolkata',
      name: 'Another Meetup',
      startsAt: '2031-06-01T10:00:00.000Z',
      endsAt: '2031-06-01T12:00:00.000Z',
      tiers: [{ name: 'General', pricePaise: 0 }],
    });
    const memberUrl = () =>
      `/v1/tenants/${tenantId}/memberships/${membershipId}/members/${uuid()}`;

    const cases: Case[] = [
      // Events and their photos are Owner/Manager setup.
      { name: 'create an event at a venue', method: 'POST', url: () => `/v1/venues/${venueId}/events`, payload: newEvent, cap: 'events.write', staff: false },
      { name: 'create an event', method: 'POST', url: () => `/v1/tenants/${tenantId}/events`, payload: () => ({ ...newEvent(), addressJson: { city: 'Pune' } }), cap: 'events.write', staff: false },
      { name: 'edit an event', method: 'PATCH', url: () => eventUrl(), payload: () => ({ name: 'Renamed' }), cap: 'events.write', staff: false },
      { name: 'publish an event', method: 'POST', url: () => eventUrl('/publish'), cap: 'events.write', staff: false },
      { name: 'end an event', method: 'POST', url: () => eventUrl('/complete'), cap: 'events.write', staff: false },
      { name: 'reopen an event', method: 'POST', url: () => eventUrl('/reopen'), cap: 'events.write', staff: false },
      { name: 'archive an event', method: 'POST', url: () => eventUrl('/archive'), cap: 'events.write', staff: false },
      { name: 'unarchive an event', method: 'POST', url: () => eventUrl('/unarchive'), cap: 'events.write', staff: false },
      { name: 'request event changes', method: 'POST', url: () => eventUrl('/change-requests'), payload: () => ({ name: 'Changed' }), cap: 'events.write', staff: false },
      { name: 'withdraw a change request', method: 'POST', url: () => eventUrl(`/change-requests/${uuid()}/withdraw`), cap: 'events.write', staff: false },
      { name: 'publish a series', method: 'POST', url: () => `/v1/tenants/${tenantId}/event-series/${uuid()}/publish`, cap: 'events.write', staff: false },
      { name: 'cancel a series', method: 'POST', url: () => `/v1/tenants/${tenantId}/event-series/${uuid()}/cancel`, cap: 'events.write', staff: false },
      { name: 'presign an event photo', method: 'POST', url: () => `/v1/events/${eventId}/images/upload-presign`, payload: () => ({ contentType: 'image/jpeg' }), cap: 'events.write', staff: false },
      { name: 'add an event photo', method: 'POST', url: () => `/v1/events/${eventId}/images`, payload: () => ({ storageKey: 'nope' }), cap: 'events.write', staff: false },
      { name: 'reorder event photos', method: 'PUT', url: () => `/v1/events/${eventId}/images/order`, payload: () => ({ imageIds: [uuid()] }), cap: 'events.write', staff: false },
      { name: 'move an event photo crop', method: 'PATCH', url: () => `/v1/events/${eventId}/images/${uuid()}`, payload: () => ({ focalX: 0.5, focalY: 0.5 }), cap: 'events.write', staff: false },
      { name: 'delete an event photo', method: 'DELETE', url: () => `/v1/events/${eventId}/images/${uuid()}`, cap: 'events.write', staff: false },
      // The event door desk is Staff work.
      { name: 'add an event registration', method: 'POST', url: () => eventUrl('/registrations'), payload: () => ({ name: 'Door Guest', lines: [{ tierId: uuid(), quantity: 1 }] }), cap: 'bookings.create', staff: true },
      // Venue photos.
      { name: 'presign a venue photo', method: 'POST', url: () => `/v1/venues/${venueId}/images/upload-presign`, payload: () => ({ contentType: 'image/jpeg' }), cap: 'venues.write', staff: false },
      { name: 'add a venue photo', method: 'POST', url: () => `/v1/venues/${venueId}/images`, payload: () => ({ storageKey: 'nope' }), cap: 'venues.write', staff: false },
      { name: 'reorder venue photos', method: 'PUT', url: () => `/v1/venues/${venueId}/images/order`, payload: () => ({ imageIds: [uuid()] }), cap: 'venues.write', staff: false },
      { name: 'move a venue photo crop', method: 'PATCH', url: () => `/v1/venues/${venueId}/images/${uuid()}`, payload: () => ({ focalX: 0.5, focalY: 0.5 }), cap: 'venues.write', staff: false },
      { name: 'delete a venue photo', method: 'DELETE', url: () => `/v1/venues/${venueId}/images/${uuid()}`, cap: 'venues.write', staff: false },
      // Membership plans are setup; the member desk is Staff work.
      { name: 'activate a plan', method: 'POST', url: () => `/v1/tenants/${tenantId}/memberships/${membershipId}/activate`, cap: 'memberships.write', staff: false },
      { name: 'deactivate a plan', method: 'POST', url: () => `/v1/tenants/${tenantId}/memberships/${membershipId}/deactivate`, cap: 'memberships.write', staff: false },
      { name: 'add a member', method: 'POST', url: () => `/v1/tenants/${tenantId}/memberships/${membershipId}/members`, payload: () => ({ name: 'Desk Member' }), cap: 'bookings.create', staff: true },
      { name: 'cancel a member', method: 'PATCH', url: memberUrl, payload: () => ({ status: 'cancelled' }), cap: 'bookings.cancel', staff: true },
      { name: "change a member's dates", method: 'PATCH', url: memberUrl, payload: () => ({ endsAt: '2031-12-31T00:00:00.000Z' }), cap: 'bookings.create', staff: true },
      // Arenas, schedules and prices are setup.
      { name: 'add an arena', method: 'POST', url: () => `/v1/venues/${venueId}/arenas`, payload: () => ({ name: 'Court B' }), cap: 'arenas.write', staff: false },
      { name: 'change arena QR rules', method: 'PATCH', url: () => `/v1/arenas/${arenaId}`, payload: () => ({ qrTicketConfig: { enabled: false } }), cap: 'arenas.write', staff: false },
      { name: 'set the weekly schedule', method: 'PUT', url: () => `/v1/arenas/${arenaId}/schedule`, payload: () => ({ rows: [] }), cap: 'schedules.write', staff: false },
      { name: 'release slots', method: 'POST', url: () => `/v1/arenas/${arenaId}/slots/release`, payload: () => ({ startDate: '2031-01-01', endDate: '2031-01-01', quantizationMin: 60, cells: [] }), idempotent: true, cap: 'schedules.write', staff: false },
      { name: 'add a pricing rule', method: 'POST', url: () => `/v1/arenas/${arenaId}/pricing-rules`, payload: () => ({ pricePaise: 100 }), cap: 'pricing.write', staff: false },
      { name: 'delete a pricing rule', method: 'DELETE', url: () => `/v1/arenas/${arenaId}/pricing-rules/${uuid()}`, cap: 'pricing.write', staff: false },
      { name: 're-price slots', method: 'PATCH', url: () => '/v1/slots/bulk', payload: () => ({ slotIds: [slotId], price: 60000 }), cap: 'pricing.write', staff: false },
      { name: 'block slots', method: 'PATCH', url: () => '/v1/slots/bulk', payload: () => ({ slotIds: [slotId], blocked: false }), cap: 'schedules.write', staff: false },
      // Taking a booking at reception is Staff work.
      { name: 'hold slots', method: 'POST', url: () => '/v1/slots/hold', payload: () => ({ slotIds: [slotId] }), cap: 'bookings.create', staff: true },
      { name: 'release a hold', method: 'POST', url: () => '/v1/slots/release-hold', payload: () => ({ slotIds: [slotId] }), cap: 'bookings.create', staff: true },
      { name: 'take a walk-in booking', method: 'POST', url: () => '/v1/bookings', payload: () => ({ slotIds: [slotId], customer: { name: 'Walk In', contact: '1234' } }), idempotent: true, cap: 'bookings.create', staff: true },
      // Webhooks are integration settings, like API keys — reading them too.
      { name: 'list webhooks', method: 'GET', url: () => `/v1/tenants/${tenantId}/webhook-subscriptions`, cap: 'integration.api_keys.manage', staff: false },
      { name: 'add a webhook', method: 'POST', url: () => `/v1/tenants/${tenantId}/webhook-subscriptions`, payload: () => ({ url: 'https://example.com/hook', events: ['booking.created'] }), cap: 'integration.api_keys.manage', staff: false },
      { name: 'delete a webhook', method: 'DELETE', url: () => `/v1/tenants/${tenantId}/webhook-subscriptions/${uuid()}`, cap: 'integration.api_keys.manage', staff: false },
      { name: 'read webhook deliveries', method: 'GET', url: () => `/v1/tenants/${tenantId}/webhook-subscriptions/${uuid()}/deliveries`, cap: 'integration.api_keys.manage', staff: false },
      // Cancelling last: it ends the event the other cases use.
      { name: 'cancel an event', method: 'POST', url: () => eventUrl('/cancel'), cap: 'events.write', staff: false },
    ];

    it.each(cases)('$name needs $cap', async (c) => {
      const send = (token: string) =>
        call(token, c.method, c.url(), c.payload?.(), c.idempotent ? withKey(token) : bearer(token));

      const denied = c.staff ? ['readonly'] : ['readonly', 'staff'];
      for (const token of denied) {
        const res = await send(token);
        expect(res.statusCode, `${token}: ${res.body}`).toBe(403);
        expect(res.json().error).toMatchObject({ code: 'forbidden_capability', details: { cap: c.cap } });
      }
      // Holders get past the check; what the route then says is its own business.
      for (const token of c.staff ? ['staff', 'owner'] : ['manager', 'owner']) {
        const res = await send(token);
        expect(res.statusCode, `${token}: ${res.body}`).not.toBe(401);
        expect(PERMISSION_CODES, `${token}: ${res.body}`).not.toContain(errorCode(res));
      }
    });

    it('still lets Read-only check customers in at the door', async () => {
      const res = await call('readonly', 'POST', `/v1/tenants/${tenantId}/qr-tickets/validate`, {
        code: 'not-a-real-pass',
      });
      expect(PERMISSION_CODES, res.body).not.toContain(errorCode(res));
    });
  });
});
