import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Consumer Help concerns (#114): consumer submit/list + admin list filters, plus
// a regression proving the existing partner submit + admin list still work.
// Integration (RUN_INTEGRATION + a real Postgres).
vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      padmin: { uid: 'fbuid_padmin_sc', email: 'padmin_sc@x.com', email_verified: true },
      owner: { uid: 'fbuid_owner_sc', email: 'owner_sc@x.com', email_verified: true },
      consumer: { uid: 'fbuid_consumer_sc', email: 'consumer_sc@x.com', email_verified: true },
      consumer2: { uid: 'fbuid_consumer2_sc', email: 'consumer2_sc@x.com', email_verified: true },
      partner: { uid: 'fbuid_partner_sc', email: 'partner_sc@x.com', email_verified: true },
    };
    const u = map[token];
    if (!u) throw new Error('bad token');
    return u;
  }),
}));

const { closeDb, db } = await import('../db/client.js');
const { buildServer } = await import('../server.js');
const { __resetPlatformTenantCacheForTesting } = await import('../lib/authz/platform_tenant.js');

const runIntegration = Boolean(process.env.RUN_INTEGRATION);
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

interface IssueRow {
  id: string;
  userId: string;
  message: string;
  status: string;
  priority: string;
  source: string;
  category: string | null;
  bookingId: string | null;
  flowAnswers: { question: string; answer: string }[] | null;
  booking?: { id: string; venueName: string | null; status: string; itemType: string } | null;
}

describe.skipIf(!runIntegration)('consumer support concerns (#114)', () => {
  let app: FastifyInstance;
  let consumerId: string;
  let ownerUserId: string;
  let tenantId: string;
  let ownedBookingId: string;
  let partnerIssueId: string;
  const SUFFIX = Date.now();
  const PLATFORM_SLUG = `circls-internal-sc-${SUFFIX}`;
  let prevSlug: string | undefined;

  beforeAll(async () => {
    prevSlug = process.env['CIRCLS_INTERNAL_TENANT_SLUG'];
    process.env['CIRCLS_INTERNAL_TENANT_SLUG'] = PLATFORM_SLUG;
    __resetPlatformTenantCacheForTesting();

    app = await buildServer();
    await app.ready();

    // Provision the platform admin (padmin) + a consumer user row.
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer('padmin') });
    expect(me.statusCode).toBe(200);
    const adminUserId = (me.json() as { id: string }).id;

    const cme = await app.inject({ method: 'GET', url: '/v1/consumer/me', headers: bearer('consumer') });
    expect(cme.statusCode).toBe(200);
    consumerId = (cme.json() as { profile: { id: string } }).profile.id;

    // A platform tenant whose slug matches the env override; make padmin a manager.
    const ptRows = await db.execute<{ id: string }>(sql`
      INSERT INTO tenants (name, slug, is_platform, status, subscription_status)
      VALUES ('Circls', ${PLATFORM_SLUG}, TRUE, 'active', 'trial')
      RETURNING id
    `);
    const platformTenantId = ((ptRows as unknown as { id: string }[])[0]!).id;
    await db.execute(sql`
      INSERT INTO tenant_members (tenant_id, user_id, role)
      VALUES (${platformTenantId}::uuid, ${adminUserId}::uuid, 'manager')
    `);

    // A regular tenant owned by `owner`, plus a booking owned by the consumer
    // (inserted directly so we don't need the full pay-and-book flow).
    const t = await app.inject({
      method: 'POST',
      url: '/v1/tenants',
      headers: bearer('owner'),
      payload: { name: `SC Co ${SUFFIX}`, slug: `sc-co-${SUFFIX}` },
    });
    expect(t.statusCode).toBe(200);
    tenantId = (t.json() as { id: string }).id;
    const ome = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer('owner') });
    ownerUserId = (ome.json() as { id: string }).id;

    const bRows = await db.execute<{ id: string }>(sql`
      INSERT INTO bookings (tenant_id, item_type, channel, payment_method, status, customer_user_id)
      VALUES (${tenantId}::uuid, 'event', 'circls', 'free', 'confirmed', ${consumerId}::uuid)
      RETURNING id
    `);
    ownedBookingId = ((bRows as unknown as { id: string }[])[0]!).id;
  });

  afterAll(async () => {
    await app.close();
    if (prevSlug === undefined) delete process.env['CIRCLS_INTERNAL_TENANT_SLUG'];
    else process.env['CIRCLS_INTERNAL_TENANT_SLUG'] = prevSlug;
    await closeDb();
  });

  it('partner submit still works and lands as source=partner_help (regression)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/support/issues',
      headers: bearer('partner'),
      payload: { message: 'Partner cannot publish a venue, please help.' },
    });
    expect(res.statusCode).toBe(200);
    const issue = res.json() as IssueRow;
    partnerIssueId = issue.id;
    expect(issue.source).toBe('partner_help');
    expect(issue.category).toBeNull();
    expect(issue.bookingId).toBeNull();
  });

  it('rejects an unauthenticated concern (401)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/consumer/support/concerns',
      payload: { category: 'other', flowAnswers: [], message: 'hi' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an invalid category (400)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/consumer/support/concerns',
      headers: bearer('consumer'),
      payload: { category: 'not_a_category', flowAnswers: [], message: 'hi' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('bad_request');
  });

  it('rejects a bookingId not owned by the caller (404)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/consumer/support/concerns',
      headers: bearer('consumer'),
      payload: {
        category: 'booking_issue',
        bookingId: '00000000-0000-0000-0000-0000000000aa',
        flowAnswers: [],
        message: 'about a booking that is not mine',
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('booking_not_found');
  });

  it('creates a consumer concern (no booking) with source=consumer_chatbot + round-trips flowAnswers', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/consumer/support/concerns',
      headers: bearer('consumer'),
      payload: {
        category: 'other',
        flowAnswers: [
          { question: 'What can we help you with?', answer: 'Something else' },
        ],
        message: 'General question about the app.',
      },
    });
    expect(res.statusCode).toBe(200);
    const issue = res.json() as IssueRow;
    expect(issue.source).toBe('consumer_chatbot');
    expect(issue.category).toBe('other');
    expect(issue.bookingId).toBeNull();
    expect(issue.status).toBe('unresolved');
    expect(issue.flowAnswers).toEqual([
      { question: 'What can we help you with?', answer: 'Something else' },
    ]);
  });

  it('creates a consumer concern linked to a booking the caller owns', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/consumer/support/concerns',
      headers: bearer('consumer'),
      payload: {
        category: 'booking_issue',
        bookingId: ownedBookingId,
        flowAnswers: [{ question: 'Which booking?', answer: 'Event booking' }],
        message: 'My booking shows the wrong time.',
      },
    });
    expect(res.statusCode).toBe(200);
    const issue = res.json() as IssueRow;
    expect(issue.bookingId).toBe(ownedBookingId);
    expect(issue.category).toBe('booking_issue');
  });

  it('GET /v1/consumer/support/concerns returns only the caller’s concerns', async () => {
    const mine = await app.inject({
      method: 'GET',
      url: '/v1/consumer/support/concerns',
      headers: bearer('consumer'),
    });
    expect(mine.statusCode).toBe(200);
    const rows = (mine.json() as { rows: IssueRow[] }).rows;
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((r) => r.userId === consumerId)).toBe(true);
    expect(rows.every((r) => r.source === 'consumer_chatbot')).toBe(true);

    // A different consumer sees none of the first consumer's concerns.
    await app.inject({ method: 'GET', url: '/v1/consumer/me', headers: bearer('consumer2') });
    const other = await app.inject({
      method: 'GET',
      url: '/v1/consumer/support/concerns',
      headers: bearer('consumer2'),
    });
    expect((other.json() as { rows: IssueRow[] }).rows).toEqual([]);
  });

  it('admin list returns new fields + booking context, and filters by source', async () => {
    const all = await app.inject({
      method: 'GET',
      url: '/v1/admin/support-issues',
      headers: bearer('padmin'),
    });
    expect(all.statusCode).toBe(200);
    const rows = all.json() as IssueRow[];
    // Both the partner issue and the consumer concerns are present.
    const partner = rows.find((r) => r.id === partnerIssueId);
    expect(partner?.source).toBe('partner_help');
    const linked = rows.find((r) => r.bookingId === ownedBookingId);
    expect(linked?.booking?.id).toBe(ownedBookingId);
    expect(linked?.booking?.itemType).toBe('event');

    const consumerOnly = await app.inject({
      method: 'GET',
      url: '/v1/admin/support-issues?source=consumer_chatbot',
      headers: bearer('padmin'),
    });
    const cRows = consumerOnly.json() as IssueRow[];
    expect(cRows.length).toBeGreaterThanOrEqual(2);
    expect(cRows.every((r) => r.source === 'consumer_chatbot')).toBe(true);
    expect(cRows.find((r) => r.id === partnerIssueId)).toBeUndefined();

    const partnerOnly = await app.inject({
      method: 'GET',
      url: '/v1/admin/support-issues?source=partner_help',
      headers: bearer('padmin'),
    });
    const pRows = partnerOnly.json() as IssueRow[];
    expect(pRows.every((r) => r.source === 'partner_help')).toBe(true);
    expect(pRows.find((r) => r.id === partnerIssueId)).toBeDefined();
  });

  it('admin list filters by category', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/support-issues?category=booking_issue',
      headers: bearer('padmin'),
    });
    const rows = res.json() as IssueRow[];
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.category === 'booking_issue')).toBe(true);
  });

  it('admin can still patch status/priority for a consumer concern', async () => {
    const list = await app.inject({
      method: 'GET',
      url: '/v1/admin/support-issues?source=consumer_chatbot',
      headers: bearer('padmin'),
    });
    const target = (list.json() as IssueRow[])[0]!;
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/support-issues/${target.id}`,
      headers: bearer('padmin'),
      payload: { status: 'in_progress', priority: 'high' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as IssueRow).status).toBe('in_progress');
    expect((res.json() as IssueRow).priority).toBe('high');
  });
});
