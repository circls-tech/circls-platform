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
      invitee: { uid: 'fbuid_acinvitee', email: 'acinvitee@x.com', email_verified: true },
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
    // These users are the same on every run: clear the questions earlier runs
    // left, so the 24-hour question limit doesn't trip a rerun.
    await clearQuestions();

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
    await clearQuestions();
    if (prevSlug === undefined) delete process.env['CIRCLS_INTERNAL_TENANT_SLUG'];
    else process.env['CIRCLS_INTERNAL_TENANT_SLUG'] = prevSlug;
    __resetPlatformTenantCacheForTesting();
    await app.close();
    await closeDb();
  });

  /** Removes the question threads this file's users asked (messages cascade). */
  async function clearQuestions(): Promise<void> {
    const ids = Object.values(userIds);
    if (ids.length === 0) return;
    await db.execute(sql`
      DELETE FROM question_threads
       WHERE author_user_id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
    `);
  }

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

    it("keeps people's contact details in the audit log to the same roles", async () => {
      // Something the owner (acowner@x.com) does lands in Acme's log.
      expect((await createPlan(tenantId)).statusCode).toBe(200);
      const log = async (token: string, q = '') =>
        (
          (await call(token, 'GET', `/v1/admin/audit-log?tenantId=${tenantId}&limit=200${q}`)).json() as {
            rows: { actorUserId: string | null; actorContact: string | null }[];
          }
        ).rows;
      const byManager = await log('pmanager');
      expect(byManager.some((r) => r.actorContact === 'acowner@x.com')).toBe(true);

      const byReadonly = await log('preadonly');
      expect(byReadonly.some((r) => r.actorUserId === userIds.owner)).toBe(true);
      expect(byReadonly.every((r) => r.actorContact === null)).toBe(true);
      // Nor can the search find someone by their contact details.
      expect(await log('preadonly', '&q=acowner%40x.com')).toHaveLength(0);
      expect((await log('pmanager', '&q=acowner%40x.com')).length).toBeGreaterThan(0);
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
    let onlineForOtherId: string;

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
          {
            ...base,
            channel: 'circls',
            paymentMethod: 'razorpay_route',
            createdByUserId: userIds.customer!,
            createdAt: new Date('2026-06-01T10:00:00Z'),
          },
          // The customer's booking, stamped properly.
          {
            ...base,
            channel: 'circls',
            paymentMethod: 'razorpay_route',
            createdByUserId: userIds.customer!,
            customerUserId: userIds.customer!,
          },
          // Taken online by staff for someone else (POST /v1/bookings with
          // razorpay_route): no customer, and made since customers are stamped.
          { ...base, channel: 'circls', paymentMethod: 'razorpay_route', createdByUserId: userIds.staff! },
        ])
        .returning({ id: bookings.id });
      [walkInId, apiBookingId, legacyId, ownId, onlineForOtherId] = rows.map((r) => r.id) as [
        string,
        string,
        string,
        string,
        string,
      ];
    });

    const listIds = async (token: string) =>
      ((await call(token, 'GET', '/v1/consumer/me/bookings')).json() as { rows: { id: string }[] }).rows.map(
        (b) => b.id,
      );

    it('are the ones made for them, not the ones they entered for others', async () => {
      const staffs = await listIds('staff');
      expect(staffs).not.toContain(walkInId);
      expect(staffs).not.toContain(onlineForOtherId);
      expect(await listIds('owner')).not.toContain(apiBookingId);
      const mine = await listIds('customer');
      expect(mine).toEqual(expect.arrayContaining([legacyId, ownId]));

      expect((await call('staff', 'GET', `/v1/consumer/me/bookings/${walkInId}`)).statusCode).toBe(404);
      expect((await call('staff', 'GET', `/v1/consumer/me/bookings/${onlineForOtherId}`)).statusCode).toBe(404);
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

    it('shows a webhook signing secret once, on create', async () => {
      const created = await call('owner', 'POST', `/v1/tenants/${tenantId}/webhook-subscriptions`, {
        url: 'https://example.com/hook',
        events: ['booking.confirmed'],
      });
      expect(created.statusCode).toBe(200);
      expect(created.json()).toHaveProperty('secret');
      const subs = (await call('owner', 'GET', `/v1/tenants/${tenantId}/webhook-subscriptions`)).json() as object[];
      expect(subs.length).toBeGreaterThan(0);
      for (const sub of subs) expect(sub).not.toHaveProperty('secret');

      // fetch can't send to a URL with credentials in it.
      const withCredentials = await call('owner', 'POST', `/v1/tenants/${tenantId}/webhook-subscriptions`, {
        url: 'https://hook:s3cret@example.com/hook',
        events: ['booking.confirmed'],
      });
      expect(withCredentials.statusCode).toBe(400);
      expect(withCredentials.json().error.message).toBe("Webhook URLs can't include a username or password");
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
    let threadId: string;
    let inviteToken: string;

    beforeAll(async () => {
      frozenId = await createTenant('owner', 'Frozen');
      const frozenVenue = await createVenue('owner', frozenId, 'Frozen Courts');
      await db.insert(tenantMembers).values([
        { userId: userIds.staff!, tenantId: frozenId, role: 'staff' },
        // A member of this organisation only.
        { userId: userIds.other!, tenantId: frozenId, role: 'readonly' },
      ]);
      // A customer's public question on one of its plans.
      const plan = await createPlan(frozenId);
      const planId = (plan.json() as { id: string }).id;
      await db.execute(sql`UPDATE memberships SET status = 'active' WHERE id = ${planId}::uuid`);
      const asked = await call('customer', 'POST', '/v1/consumer/questions', {
        subjectType: 'membership',
        subjectId: planId,
        visibility: 'public',
        body: 'Is the pass still valid?',
      });
      expect(asked.statusCode).toBe(200);
      threadId = (asked.json() as { thread: { id: string } }).thread.id;
      // An invitation sent before the suspension.
      const invite = await call('owner', 'POST', `/v1/tenants/${frozenId}/invitations`, {
        email: 'acinvitee@x.com',
        role: 'manager',
      });
      expect(invite.statusCode).toBe(201);
      inviteToken = (invite.json() as { token: string }).token;
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
      // Integrations included.
      expect((await call('owner', 'GET', `/v1/tenants/${frozenId}/api-keys`)).statusCode).toBe(200);
      expect((await call('owner', 'GET', `/v1/tenants/${frozenId}/webhook-subscriptions`)).statusCode).toBe(200);
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
        await call('owner', 'POST', `/v1/tenants/${frozenId}/api-keys`, { name: 'Late key', role: 'read' }),
        await call(null, 'POST', `/v1/invitations/${inviteToken}/accept`, { firebaseIdToken: 'invitee' }),
      ];
      for (const res of attempts) {
        expect(res.statusCode, res.body).toBe(403);
        expect(res.json().error.code).toBe('tenant_suspended');
      }
      const lookup = await call(null, 'GET', `/v1/invitations/lookup?token=${inviteToken}`);
      expect(lookup.json()).toMatchObject({ tenantSuspended: true });
    });

    it("doesn't let its members answer customers as the organisation", async () => {
      // The consumer surface too: staff can still reply, but as themselves.
      const res = await call('staff', 'POST', `/v1/consumer/questions/${threadId}/messages`, {
        body: 'We will be back soon.',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ message: { authorKind: 'consumer' }, threadStatus: 'open' });
    });

    it("stops selling, but lets customers cancel and the org reach support", async () => {
      const book = await call('customer', 'POST', `/v1/events/${eventId}/book`, {
        lines: [{ tierId, quantity: 1 }],
      });
      expect(book.statusCode).toBe(404);

      const selfCancel = await call('customer', 'POST', `/v1/bookings/${bookingId}/cancel`, {});
      expect(selfCancel.statusCode).toBe(200);

      // By someone who belongs to no other organisation.
      const support = await call('other', 'POST', '/v1/support/issues', {
        message: 'We were suspended and need help.',
      });
      expect(support.statusCode).toBe(200);
    });
  });
});
