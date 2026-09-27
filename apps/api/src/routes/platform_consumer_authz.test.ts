import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Authorization outside the partner write routes: platform user reports and
// support issues, whose bookings a consumer sees, the older purchase/booking
// routes, cross-tenant venue references, a few payload leaks, and what a
// suspended organisation can still do. Integration-gated (needs Postgres).
vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      owner: { uid: 'fbuid_acowner', email: 'acowner@x.com', email_verified: true },
      staff: { uid: 'fbuid_acstaff', email: 'acstaff@x.com', email_verified: true },
      customer: { uid: 'fbuid_accustomer', email: 'accustomer@x.com', email_verified: true },
      other: { uid: 'fbuid_acother', email: 'acother@x.com', email_verified: true },
      rival: { uid: 'fbuid_acrival', email: 'acrival@x.com', email_verified: true },
      pmanager: { uid: 'fbuid_acpmanager', email: 'acpmanager@x.com', email_verified: true },
      pstaff: { uid: 'fbuid_acpstaff', email: 'acpstaff@x.com', email_verified: true },
      preadonly: { uid: 'fbuid_acpreadonly', email: 'acpreadonly@x.com', email_verified: true },
    };
    const u = map[token];
    if (!u) throw new Error('bad token');
    return u;
  }),
}));

const { closeDb, db } = await import('../db/client.js');
const { bookings, tenantMembers } = await import('../db/schema/index.js');
const { __resetPlatformTenantCacheForTesting } = await import('../lib/authz/platform_tenant.js');
const { buildServer } = await import('../server.js');

const runIntegration = Boolean(process.env.RUN_INTEGRATION);
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const SUFFIX = Date.now();
const PLATFORM_SLUG = `circls-internal-test-ac-${SUFFIX}`;

describe.skipIf(!runIntegration)('platform, consumer and cross-tenant authorization', () => {
  let app: FastifyInstance;
  let prevSlug: string | undefined;
  const userIds: Record<string, string> = {};
  let tenantId: string;
  let venueId: string;
  let rivalVenueId: string;

  type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
  const call = (token: string | null, method: Method, url: string, payload?: object) =>
    app.inject({ method, url, headers: token ? bearer(token) : {}, ...(payload ? { payload } : {}) });

  async function createTenant(token: string, name: string): Promise<string> {
    const res = await call(token, 'POST', '/v1/tenants', {
      name,
      slug: `ac-${token}-${name.toLowerCase().replace(/\W+/g, '-')}-${SUFFIX}`,
      country: 'India',
      acceptTerms: true,
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { id: string }).id;
  }

  async function createVenue(token: string, tenant: string, name: string): Promise<string> {
    const res = await call(token, 'POST', `/v1/tenants/${tenant}/venues`, { name });
    expect(res.statusCode).toBe(200);
    return (res.json() as { id: string }).id;
  }

  async function firstTierId(eventId: string): Promise<string> {
    const rows = await db.execute<{ id: string }>(
      sql`SELECT id FROM event_ticket_tiers WHERE event_id = ${eventId}::uuid LIMIT 1`,
    );
    return (rows as unknown as { id: string }[])[0]!.id;
  }

  async function createPlan(tenant: string, payload: object = {}) {
    return call('owner', 'POST', `/v1/tenants/${tenant}/memberships`, {
      name: 'Gold',
      pricePaise: 0,
      durationDays: 30,
      ...payload,
    });
  }

  beforeAll(async () => {
    prevSlug = process.env['CIRCLS_INTERNAL_TENANT_SLUG'];
    process.env['CIRCLS_INTERNAL_TENANT_SLUG'] = PLATFORM_SLUG;
    __resetPlatformTenantCacheForTesting();
    app = await buildServer();
    await app.ready();

    for (const token of ['owner', 'staff', 'customer', 'other', 'rival', 'pmanager', 'pstaff', 'preadonly']) {
      const me = await call(token, 'GET', '/v1/me');
      expect(me.statusCode).toBe(200);
      userIds[token] = (me.json() as { id: string }).id;
    }

    // The Circls platform tenant, with one member per role that matters here.
    const pt = await db.execute<{ id: string }>(sql`
      INSERT INTO tenants (name, slug, is_platform, status, subscription_status)
      VALUES ('Circls', ${PLATFORM_SLUG}, TRUE, 'active', 'trial')
      RETURNING id
    `);
    const platformTenantId = (pt as unknown as { id: string }[])[0]!.id;
    await db.insert(tenantMembers).values([
      { userId: userIds.pmanager!, tenantId: platformTenantId, role: 'manager' },
      { userId: userIds.pstaff!, tenantId: platformTenantId, role: 'staff' },
      { userId: userIds.preadonly!, tenantId: platformTenantId, role: 'readonly' },
    ]);

    tenantId = await createTenant('owner', 'Acme');
    venueId = await createVenue('owner', tenantId, 'Acme Courts');
    await db.execute(sql`UPDATE venues SET status = 'active' WHERE id = ${venueId}::uuid`);
    await db.insert(tenantMembers).values({ userId: userIds.staff!, tenantId, role: 'staff' });

    const rivalTenantId = await createTenant('rival', 'Rival');
    rivalVenueId = await createVenue('rival', rivalTenantId, 'Rival Courts');
  });

  afterAll(async () => {
    if (prevSlug === undefined) delete process.env['CIRCLS_INTERNAL_TENANT_SLUG'];
    else process.env['CIRCLS_INTERNAL_TENANT_SLUG'] = prevSlug;
    __resetPlatformTenantCacheForTesting();
    await app.close();
    await closeDb();
  });

  describe('platform user reports and support issues', () => {
    it('lets only platform Owners and Managers read the user reports', async () => {
      expect((await call('pmanager', 'GET', '/v1/admin/users/consumers')).statusCode).toBe(200);
      for (const token of ['pstaff', 'preadonly']) {
        for (const report of ['consumers', 'partners']) {
          const res = await call(token, 'GET', `/v1/admin/users/${report}`);
          expect(res.statusCode, `${token} ${report}`).toBe(403);
          expect(res.json().error.details).toEqual({ cap: 'admin.users.read' });
        }
      }
    });

    it('takes support issues from partners only, and changes from support writers only', async () => {
      const message = 'The reception grid will not load for me.';
      const fromConsumer = await call('customer', 'POST', '/v1/support/issues', { message });
      expect(fromConsumer.statusCode).toBe(403);
      expect(fromConsumer.json().error.code).toBe('partner_only');

      const issue = await call('owner', 'POST', '/v1/support/issues', { message });
      expect(issue.statusCode).toBe(200);
      const issueId = (issue.json() as { id: string }).id;

      expect((await call('preadonly', 'GET', '/v1/admin/support-issues')).statusCode).toBe(200);
      const byReadonly = await call('preadonly', 'PATCH', `/v1/admin/support-issues/${issueId}`, {
        status: 'in_progress',
      });
      expect(byReadonly.statusCode).toBe(403);
      expect(byReadonly.json().error.details).toEqual({ cap: 'admin.support.write' });

      const byStaff = await call('pstaff', 'PATCH', `/v1/admin/support-issues/${issueId}`, {
        status: 'in_progress',
      });
      expect(byStaff.statusCode).toBe(200);
      expect(byStaff.json()).toMatchObject({ id: issueId, status: 'in_progress' });

      expect((await call('pstaff', 'PATCH', `/v1/admin/support-issues/${issueId}`, {})).statusCode).toBe(400);
      for (const id of [crypto.randomUUID(), 'not-a-uuid']) {
        const res = await call('pstaff', 'PATCH', `/v1/admin/support-issues/${id}`, { status: 'resolved' });
        expect(res.statusCode).toBe(404);
      }
    });
  });

  describe("a consumer's own bookings", () => {
    let walkInId: string;
    let apiBookingId: string;
    let legacyId: string;
    let ownId: string;

    beforeAll(async () => {
      const base = {
        tenantId,
        venueId,
        itemType: 'slot' as const,
        status: 'confirmed' as const,
        customerName: 'Somebody',
        customerContact: '+91-9000000459',
        totalPaise: 50000,
      };
      const rows = await db
        .insert(bookings)
        .values([
          // Entered at the desk by staff for a walk-in customer.
          { ...base, channel: 'walkin', paymentMethod: 'external', createdByUserId: userIds.staff! },
          // Booked through an API key, stamped with the owner as creator.
          { ...base, channel: 'aggregator', paymentMethod: 'external', createdByUserId: userIds.owner! },
          // A consumer booking from before customers were stamped.
          { ...base, channel: 'circls', paymentMethod: 'razorpay_route', createdByUserId: userIds.customer! },
          // The customer's booking, stamped properly.
          {
            ...base,
            channel: 'circls',
            paymentMethod: 'razorpay_route',
            createdByUserId: userIds.customer!,
            customerUserId: userIds.customer!,
          },
        ])
        .returning({ id: bookings.id });
      [walkInId, apiBookingId, legacyId, ownId] = rows.map((r) => r.id) as [string, string, string, string];
    });

    const listIds = async (token: string) =>
      ((await call(token, 'GET', '/v1/consumer/me/bookings')).json() as { rows: { id: string }[] }).rows.map(
        (b) => b.id,
      );

    it('are the ones made for them, not the ones they entered for others', async () => {
      expect(await listIds('staff')).not.toContain(walkInId);
      expect(await listIds('owner')).not.toContain(apiBookingId);
      const mine = await listIds('customer');
      expect(mine).toEqual(expect.arrayContaining([legacyId, ownId]));

      expect((await call('staff', 'GET', `/v1/consumer/me/bookings/${walkInId}`)).statusCode).toBe(404);
      expect((await call('customer', 'GET', `/v1/consumer/me/bookings/${legacyId}`)).statusCode).toBe(200);
    });
  });

  describe('the older purchase and booking routes', () => {
    it("won't sell a plan that isn't on sale", async () => {
      const plan = await createPlan(tenantId);
      expect(plan.statusCode).toBe(200);
      const planId = (plan.json() as { id: string }).id;

      const pending = await call('customer', 'POST', `/v1/memberships/${planId}/purchase`, {});
      expect(pending.statusCode).toBe(404);
      expect(pending.json().error.code).toBe('membership_not_found');

      await db.execute(sql`UPDATE memberships SET status = 'active' WHERE id = ${planId}::uuid`);
      expect((await call('customer', 'POST', `/v1/memberships/${planId}/purchase`, {})).statusCode).toBe(200);
    });

    it("won't book an event whose venue isn't visible", async () => {
      const hiddenVenue = await createVenue('owner', tenantId, 'Hidden Courts');
      await db.execute(sql`UPDATE venues SET status = 'pending_review' WHERE id = ${hiddenVenue}::uuid`);
      const ev = await call('owner', 'POST', `/v1/venues/${hiddenVenue}/events`, {
        name: 'Hidden Cup',
        tzName: 'Asia/Kolkata',
        startsAt: '2031-07-01T10:00:00.000Z',
        endsAt: '2031-07-01T12:00:00.000Z',
        tiers: [{ name: 'General', pricePaise: 0 }],
      });
      expect(ev.statusCode).toBe(200);
      const eventId = (ev.json() as { id: string }).id;
      await db.execute(sql`UPDATE events SET status = 'published' WHERE id = ${eventId}::uuid`);

      const res = await call('customer', 'POST', `/v1/events/${eventId}/book`, {
        lines: [{ tierId: await firstTierId(eventId), quantity: 1 }],
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('cross-tenant references and payload leaks', () => {
    it("won't point a plan at another organisation's venue", async () => {
      const create = await createPlan(tenantId, { venueId: rivalVenueId });
      expect(create.statusCode).toBe(404);
      expect(create.json().error.code).toBe('venue_not_found');

      const plan = await createPlan(tenantId, { venueId });
      expect(plan.statusCode).toBe(200);
      const patch = await call(
        'owner',
        'PATCH',
        `/v1/tenants/${tenantId}/memberships/${(plan.json() as { id: string }).id}`,
        { venueId: rivalVenueId },
      );
      expect(patch.statusCode).toBe(404);
      expect(patch.json().error.code).toBe('venue_not_found');
    });

    it("shows a public question's author id only to its author", async () => {
      const plan = await createPlan(tenantId);
      const planId = (plan.json() as { id: string }).id;
      await db.execute(sql`UPDATE memberships SET status = 'active' WHERE id = ${planId}::uuid`);
      const asked = await call('customer', 'POST', '/v1/consumer/questions', {
        subjectType: 'membership',
        subjectId: planId,
        visibility: 'public',
        body: 'Does the pass cover weekends?',
      });
      expect(asked.statusCode).toBe(200);
      const threadId = (asked.json() as { thread: { id: string } }).thread.id;

      const authorId = async (token: string | null) =>
        ((await call(token, 'GET', `/v1/consumer/questions/${threadId}`)).json() as {
          thread: { authorUserId: string | null };
        }).thread.authorUserId;
      expect(await authorId(null)).toBeNull();
      expect(await authorId('other')).toBeNull();
      expect(await authorId('customer')).toBe(userIds.customer);
    });

    it('never returns API key hashes', async () => {
      const created = await call('owner', 'POST', `/v1/tenants/${tenantId}/api-keys`, {
        name: 'Aggregator',
        role: 'read',
      });
      expect(created.statusCode).toBeLessThan(300);
      const keys = (await call('owner', 'GET', `/v1/tenants/${tenantId}/api-keys`)).json() as object[];
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) expect(key).not.toHaveProperty('keyHash');
    });
  });

  // Last: suspends its own organisation.
  describe('a suspended organisation', () => {
    let frozenId: string;
    let bookingId: string;
    let eventId: string;
    let tierId: string;

    beforeAll(async () => {
      frozenId = await createTenant('owner', 'Frozen');
      const frozenVenue = await createVenue('owner', frozenId, 'Frozen Courts');
      await db.insert(tenantMembers).values({ userId: userIds.staff!, tenantId: frozenId, role: 'staff' });
      const start = new Date(Date.now() + 48 * 3_600_000);
      const end = new Date(start.getTime() + 3_600_000);
      const [b] = await db
        .insert(bookings)
        .values({
          tenantId: frozenId,
          venueId: frozenVenue,
          itemType: 'slot',
          channel: 'circls',
          paymentMethod: 'free',
          status: 'confirmed',
          customerName: 'Frozen Customer',
          customerContact: '+91-9000000460',
          customerUserId: userIds.customer!,
          totalPaise: 0,
          timeRange: `[${start.toISOString()},${end.toISOString()})`,
        })
        .returning({ id: bookings.id });
      bookingId = b!.id;
      const ev = await call('owner', 'POST', `/v1/tenants/${frozenId}/events`, {
        addressJson: { city: 'Pune' },
        tzName: 'Asia/Kolkata',
        name: 'Frozen Meetup',
        startsAt: '2031-08-01T10:00:00.000Z',
        endsAt: '2031-08-01T12:00:00.000Z',
        tiers: [{ name: 'General', pricePaise: 0 }],
      });
      expect(ev.statusCode).toBe(200);
      eventId = (ev.json() as { id: string }).id;
      tierId = await firstTierId(eventId);
      await db.execute(sql`UPDATE events SET status = 'published' WHERE id = ${eventId}::uuid`);
      await db.execute(sql`UPDATE tenants SET status = 'suspended' WHERE id = ${frozenId}::uuid`);
    });

    it('can still be looked at', async () => {
      expect((await call('owner', 'GET', `/v1/tenants/${frozenId}/members`)).statusCode).toBe(200);
      expect((await call('owner', 'GET', `/v1/bookings/${bookingId}`)).statusCode).toBe(200);
      const peek = await call('owner', 'POST', `/v1/tenants/${frozenId}/qr-tickets/validate`, {
        code: 'not-a-real-pass',
        consume: false,
      });
      expect(peek.json()?.error?.code).not.toBe('tenant_suspended');
    });

    it('changes nothing, whatever the role', async () => {
      const attempts = [
        await call('owner', 'POST', `/v1/tenants/${frozenId}/venues`, { name: 'More Courts' }),
        await call('staff', 'POST', `/v1/bookings/${bookingId}/cancel`, { reason: 'suspended' }),
        await call('owner', 'POST', `/v1/tenants/${frozenId}/qr-tickets/validate`, { code: 'not-a-real-pass' }),
      ];
      for (const res of attempts) {
        expect(res.statusCode, res.body).toBe(403);
        expect(res.json().error.code).toBe('tenant_suspended');
      }
    });

    it("stops selling, but lets customers cancel and the org reach support", async () => {
      const book = await call('customer', 'POST', `/v1/events/${eventId}/book`, {
        lines: [{ tierId, quantity: 1 }],
      });
      expect(book.statusCode).toBe(404);

      const selfCancel = await call('customer', 'POST', `/v1/bookings/${bookingId}/cancel`, {});
      expect(selfCancel.statusCode).toBe(200);

      const support = await call('owner', 'POST', '/v1/support/issues', {
        message: 'We were suspended and need help.',
      });
      expect(support.statusCode).toBe(200);
    });
  });
});
