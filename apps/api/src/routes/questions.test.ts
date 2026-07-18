import type { FastifyInstance } from 'fastify';
import { sql, type SQL } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Questions threads (design doc 2026-07-18): consumer ask (public + private),
// visibility enforcement, reply permissions, closed-thread rejection, status
// auto-transitions, org inbox + capability denial, admin reply + moderation,
// root-hide rules, rate limits, pagination.
// Integration (RUN_INTEGRATION + a real Postgres).
//
// RUN makes every identity unique per run: the per-user thread rate limit
// (10/24h) would otherwise trip on the second run against a shared DB.
const RUN = vi.hoisted(() => Date.now());
vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      padmin: { uid: `fbuid_padmin_qt_${RUN}`, email: `padmin_qt_${RUN}@x.com`, email_verified: true },
      preadonly: { uid: `fbuid_preadonly_qt_${RUN}`, email: `preadonly_qt_${RUN}@x.com`, email_verified: true },
      owner: { uid: `fbuid_owner_qt_${RUN}`, email: `owner_qt_${RUN}@x.com`, email_verified: true },
      readonly: { uid: `fbuid_readonly_qt_${RUN}`, email: `readonly_qt_${RUN}@x.com`, email_verified: true },
      asker: { uid: `fbuid_asker_qt_${RUN}`, email: `asker_qt_${RUN}@x.com`, email_verified: true },
      rando: { uid: `fbuid_rando_qt_${RUN}`, email: `rando_qt_${RUN}@x.com`, email_verified: true },
      // Support-intake persona: owns the bookings used by the intake + context
      // tests (kept separate so the earlier personas' thread rate limits don't
      // interfere).
      booker: { uid: `fbuid_booker_qt_${RUN}`, email: `booker_qt_${RUN}@x.com`, email_verified: true },
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

interface ThreadRow {
  id: string;
  subjectType: string;
  subjectId: string | null;
  tenantId: string;
  visibility: string;
  status: string;
  origin: string;
  category: string | null;
  rootBody: string;
  replyCount: number;
  authorName: string;
  lastMessageAt: string;
  createdAt: string;
  subject?: { type: string; id: string | null; name: string };
  archivedAt?: string | null;
  archivedByKind?: 'org' | 'circls' | null;
  contextBookingId?: string | null;
}

interface MessageRow {
  id: string;
  threadId: string;
  authorKind: string;
  authorName: string;
  own: boolean;
  body: string;
  hiddenAt: string | null;
  hiddenByKind?: 'org' | 'circls' | null;
  createdAt: string;
}

interface ThreadDetail {
  thread: {
    id: string;
    subjectType: string;
    subjectId: string | null;
    tenantId: string;
    visibility: string;
    status: string;
    origin: string;
    category: string | null;
    authorUserId: string;
    messageCount: number;
    lastMessageAt: string;
    createdAt: string;
    subject: { type: string; id: string | null; name: string };
    authorName: string;
    archivedAt?: string | null;
    archivedByKind?: 'org' | 'circls' | null;
    contextBookingId?: string | null;
    flowAnswers?: { question: string; answer: string }[] | null;
  };
  messages: MessageRow[];
}

interface ListPage {
  rows: ThreadRow[];
  nextCursor: string | null;
}

function firstRow<T>(res: unknown): T {
  return ((res as unknown as T[])[0])!;
}

describe.skipIf(!runIntegration)('questions threads', () => {
  let app: FastifyInstance;
  let tenantId: string;
  let platformTenantId: string;
  let eventId: string;
  let draftEventId: string;
  let membershipId: string;
  let arenaId: string;
  let askerId: string;
  const TENANT_NAME_SUFFIX = Date.now();
  const TENANT_NAME = `QT Sports ${TENANT_NAME_SUFFIX}`;
  const SUFFIX = TENANT_NAME_SUFFIX;
  const PLATFORM_SLUG = `circls-internal-qt-${SUFFIX}`;
  let prevSlug: string | undefined;

  // Threads under test: P = public (on the event), V = private (on the membership).
  let publicThreadId: string;
  let privateThreadId: string;
  let randoReplyId: string;
  let publicRootId: string;
  let privateRootId: string;

  beforeAll(async () => {
    prevSlug = process.env['CIRCLS_INTERNAL_TENANT_SLUG'];
    process.env['CIRCLS_INTERNAL_TENANT_SLUG'] = PLATFORM_SLUG;
    __resetPlatformTenantCacheForTesting();

    app = await buildServer();
    await app.ready();

    // Users: padmin (platform manager), owner, readonly (org member), asker, rando.
    const padminMe = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer('padmin') });
    expect(padminMe.statusCode).toBe(200);
    const padminId = (padminMe.json() as { id: string }).id;

    const askerMe = await app.inject({ method: 'GET', url: '/v1/consumer/me', headers: bearer('asker') });
    expect(askerMe.statusCode).toBe(200);
    askerId = (askerMe.json() as { profile: { id: string } }).profile.id;
    await app.inject({ method: 'GET', url: '/v1/consumer/me', headers: bearer('rando') });

    const ptRows = await db.execute<{ id: string }>(sql`
      INSERT INTO tenants (name, slug, is_platform, status, subscription_status)
      VALUES ('Circls', ${PLATFORM_SLUG}, TRUE, 'active', 'trial')
      RETURNING id
    `);
    platformTenantId = firstRow<{ id: string }>(ptRows).id;
    await db.execute(sql`
      INSERT INTO tenant_members (tenant_id, user_id, role)
      VALUES (${platformTenantId}::uuid, ${padminId}::uuid, 'manager')
    `);

    // Platform READONLY member: reads admin surfaces but lacks
    // admin.support.write, so consumer-surface posts must stamp `consumer`.
    const preadonlyMe = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer('preadonly') });
    expect(preadonlyMe.statusCode).toBe(200);
    const preadonlyId = (preadonlyMe.json() as { id: string }).id;
    await db.execute(sql`
      INSERT INTO tenant_members (tenant_id, user_id, role)
      VALUES (${platformTenantId}::uuid, ${preadonlyId}::uuid, 'readonly')
    `);

    // The org: tenant + contact email, a venue + active arena, a published
    // org-scoped event, a draft event, and an active membership.
    const t = await app.inject({
      method: 'POST',
      url: '/v1/tenants',
      headers: bearer('owner'),
      payload: { name: TENANT_NAME, slug: `qt-sports-${SUFFIX}` },
    });
    expect(t.statusCode).toBe(200);
    tenantId = (t.json() as { id: string }).id;
    await db.execute(sql`
      UPDATE tenants SET status = 'active', contact_email = ${'org_qt_' + RUN + '@x.com'}
      WHERE id = ${tenantId}::uuid
    `);

    const roMe = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer('readonly') });
    const readonlyId = (roMe.json() as { id: string }).id;
    await db.execute(sql`
      INSERT INTO tenant_members (tenant_id, user_id, role)
      VALUES (${tenantId}::uuid, ${readonlyId}::uuid, 'readonly')
    `);

    const vRows = await db.execute<{ id: string }>(sql`
      INSERT INTO venues (tenant_id, name, status) VALUES (${tenantId}::uuid, 'QT Venue', 'active')
      RETURNING id
    `);
    const venueId = firstRow<{ id: string }>(vRows).id;
    const aRows = await db.execute<{ id: string }>(sql`
      INSERT INTO arenas (venue_id, name, status) VALUES (${venueId}::uuid, 'QT Court 1', 'active')
      RETURNING id
    `);
    arenaId = firstRow<{ id: string }>(aRows).id;

    const eRows = await db.execute<{ id: string }>(sql`
      INSERT INTO events (tenant_id, name, status, starts_at, ends_at, address_json, tz_name)
      VALUES (${tenantId}::uuid, 'QT Cup', 'published', now() + interval '7 days', now() + interval '7 days 2 hours', '{"city":"Pune"}'::jsonb, 'Asia/Kolkata')
      RETURNING id
    `);
    eventId = firstRow<{ id: string }>(eRows).id;
    const deRows = await db.execute<{ id: string }>(sql`
      INSERT INTO events (tenant_id, name, status, starts_at, ends_at, address_json, tz_name)
      VALUES (${tenantId}::uuid, 'QT Draft', 'draft', now() + interval '7 days', now() + interval '7 days 2 hours', '{"city":"Pune"}'::jsonb, 'Asia/Kolkata')
      RETURNING id
    `);
    draftEventId = firstRow<{ id: string }>(deRows).id;

    const mRows = await db.execute<{ id: string }>(sql`
      INSERT INTO memberships (tenant_id, name, duration_days, status)
      VALUES (${tenantId}::uuid, 'QT Gold', 30, 'active')
      RETURNING id
    `);
    membershipId = firstRow<{ id: string }>(mRows).id;
  });

  afterAll(async () => {
    await app.close();
    if (prevSlug === undefined) delete process.env['CIRCLS_INTERNAL_TENANT_SLUG'];
    else process.env['CIRCLS_INTERNAL_TENANT_SLUG'] = prevSlug;
    await closeDb();
  });

  // ── Ask ─────────────────────────────────────────────────────────────────────

  it('signed-out public list starts empty', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/consumer/questions?subjectType=event&subjectId=${eventId}`,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as ListPage).rows).toEqual([]);
  });

  it('asker creates a PUBLIC thread on the event', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/consumer/questions',
      headers: bearer('asker'),
      payload: {
        subjectType: 'event',
        subjectId: eventId,
        visibility: 'public',
        body: 'Is parking available at the venue for QT Cup?',
      },
    });
    expect(res.statusCode).toBe(200);
    const detail = res.json() as ThreadDetail;
    publicThreadId = detail.thread.id;
    expect(detail.thread.visibility).toBe('public');
    expect(detail.thread.status).toBe('open');
    expect(detail.thread.subjectType).toBe('event');
    expect(detail.thread.subjectId).toBe(eventId);
    expect(detail.thread.tenantId).toBe(tenantId);
    expect(detail.thread.messageCount).toBe(1);
    // Detail enrichment: subject summary + asker display name.
    expect(detail.thread.subject).toEqual({ type: 'event', id: eventId, name: 'QT Cup' });
    expect(detail.thread.authorName).toBe('Member');
    expect(detail.messages).toHaveLength(1);
    expect(detail.messages[0]!.authorKind).toBe('consumer');
    expect(detail.messages[0]!.authorName).toBe('Member');
    expect(detail.messages[0]!.own).toBe(true);
    publicRootId = detail.messages[0]!.id;
  });

  it('asker creates a PRIVATE thread on the membership', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/consumer/questions',
      headers: bearer('asker'),
      payload: {
        subjectType: 'membership',
        subjectId: membershipId,
        visibility: 'private',
        body: 'Can I pause my QT Gold membership while travelling?',
      },
    });
    expect(res.statusCode).toBe(200);
    const detail = res.json() as ThreadDetail;
    privateThreadId = detail.thread.id;
    expect(detail.thread.visibility).toBe('private');
    privateRootId = detail.messages[0]!.id;
  });

  it('rejects asking on a non-published subject (404, no leak)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/consumer/questions',
      headers: bearer('asker'),
      payload: {
        subjectType: 'event',
        subjectId: draftEventId,
        visibility: 'public',
        body: 'Should not be possible on a draft event.',
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('event_not_found');
  });

  it('rejects a whitespace-only body (400)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/consumer/questions',
      headers: bearer('asker'),
      payload: { subjectType: 'event', subjectId: eventId, visibility: 'public', body: '   ' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('bad_request');
  });

  it('rejects an unauthenticated ask (401)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/consumer/questions',
      payload: { subjectType: 'event', subjectId: eventId, visibility: 'public', body: 'hi there' },
    });
    expect(res.statusCode).toBe(401);
  });

  // ── Visibility ─────────────────────────────────────────────────────────────

  it('signed-out visitor can read the public thread (own is always false)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/consumer/questions/${publicThreadId}`,
    });
    expect(res.statusCode).toBe(200);
    const detail = res.json() as ThreadDetail;
    expect(detail.messages).toHaveLength(1);
    expect(detail.messages[0]!.own).toBe(false);
    expect(detail.thread.subject.name).toBe('QT Cup');
  });

  it('private thread 404s for signed-out and non-author viewers', async () => {
    const anon = await app.inject({
      method: 'GET',
      url: `/v1/consumer/questions/${privateThreadId}`,
    });
    expect(anon.statusCode).toBe(404);
    expect(anon.json().error.code).toBe('question_not_found');

    const other = await app.inject({
      method: 'GET',
      url: `/v1/consumer/questions/${privateThreadId}`,
      headers: bearer('rando'),
    });
    expect(other.statusCode).toBe(404);
    expect(other.json().error.code).toBe('question_not_found');
  });

  it('author and org members can read the private thread', async () => {
    const author = await app.inject({
      method: 'GET',
      url: `/v1/consumer/questions/${privateThreadId}`,
      headers: bearer('asker'),
    });
    expect(author.statusCode).toBe(200);

    const org = await app.inject({
      method: 'GET',
      url: `/v1/consumer/questions/${privateThreadId}`,
      headers: bearer('owner'),
    });
    expect(org.statusCode).toBe(200);
  });

  it('public list shows only the public thread; /mine shows both', async () => {
    const pub = await app.inject({
      method: 'GET',
      url: `/v1/consumer/questions?subjectType=event&subjectId=${eventId}`,
    });
    const pubRows = (pub.json() as ListPage).rows;
    expect(pubRows).toHaveLength(1);
    expect(pubRows[0]!.id).toBe(publicThreadId);
    expect(pubRows[0]!.rootBody).toContain('parking');
    expect(pubRows[0]!.replyCount).toBe(0);

    const mine = await app.inject({
      method: 'GET',
      url: '/v1/consumer/questions/mine',
      headers: bearer('asker'),
    });
    expect(mine.statusCode).toBe(200);
    const mineRows = (mine.json() as ListPage).rows;
    expect(mineRows.map((r) => r.id).sort()).toEqual([publicThreadId, privateThreadId].sort());
    expect(mineRows.every((r) => r.subject !== undefined)).toBe(true);

    const filtered = await app.inject({
      method: 'GET',
      url: `/v1/consumer/questions/mine?subjectType=membership&subjectId=${membershipId}`,
      headers: bearer('asker'),
    });
    expect((filtered.json() as ListPage).rows.map((r) => r.id)).toEqual([privateThreadId]);
  });

  // ── Replies + status transitions ───────────────────────────────────────────

  it('any signed-in user can reply on a public thread (stays open)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/consumer/questions/${publicThreadId}/messages`,
      headers: bearer('rando'),
      payload: { body: 'Also wondering about parking!' },
    });
    expect(res.statusCode).toBe(200);
    const out = res.json() as { message: MessageRow; threadStatus: string };
    expect(out.message.authorKind).toBe('consumer');
    expect(out.threadStatus).toBe('open');
    randoReplyId = out.message.id;
  });

  it('non-author cannot reply on a private thread (404)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/consumer/questions/${privateThreadId}/messages`,
      headers: bearer('rando'),
      payload: { body: 'sneaky reply' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('question_not_found');
  });

  it('org reply via partner endpoint auto-answers an open thread', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/questions/${publicThreadId}/messages`,
      headers: bearer('owner'),
      payload: { body: 'Yes — free parking on site.' },
    });
    expect(res.statusCode).toBe(200);
    const out = res.json() as { message: MessageRow; threadStatus: string };
    expect(out.message.authorKind).toBe('org');
    expect(out.message.authorName).toBe(TENANT_NAME);
    expect(out.message.own).toBe(true);
    expect(out.threadStatus).toBe('answered');
  });

  it('author reply on an answered thread reopens it', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/consumer/questions/${publicThreadId}/messages`,
      headers: bearer('asker'),
      payload: { body: 'Thanks — is it also open overnight?' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { threadStatus: string }).threadStatus).toBe('open');
  });

  // ── Capability-gated author_kind stamping (questions.write / admin.support.write) ──

  it('a READONLY org member posting via the consumer endpoint is stamped consumer', async () => {
    // readonly lacks questions.write → must not speak for the org, and a
    // consumer non-author reply on an open public thread leaves it open.
    const res = await app.inject({
      method: 'POST',
      url: `/v1/consumer/questions/${publicThreadId}/messages`,
      headers: bearer('readonly'),
      payload: { body: 'I work there but cannot answer officially.' },
    });
    expect(res.statusCode).toBe(200);
    const out = res.json() as { message: MessageRow; threadStatus: string };
    expect(out.message.authorKind).toBe('consumer');
    expect(out.message.own).toBe(true);
    expect(out.threadStatus).toBe('open');
  });

  it('a READONLY org member cannot post on someone else’s private thread (404), but can read it', async () => {
    const reply = await app.inject({
      method: 'POST',
      url: `/v1/consumer/questions/${privateThreadId}/messages`,
      headers: bearer('readonly'),
      payload: { body: 'readonly sneaking into a private thread' },
    });
    expect(reply.statusCode).toBe(404);
    expect(reply.json().error.code).toBe('question_not_found');

    // Reading stays allowed (questions.read parity with the partner surface).
    const read = await app.inject({
      method: 'GET',
      url: `/v1/consumer/questions/${privateThreadId}`,
      headers: bearer('readonly'),
    });
    expect(read.statusCode).toBe(200);
  });

  it('a READONLY platform member posting via the consumer endpoint is stamped consumer', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/consumer/questions/${publicThreadId}/messages`,
      headers: bearer('preadonly'),
      payload: { body: 'Circls employee off duty here.' },
    });
    expect(res.statusCode).toBe(200);
    const out = res.json() as { message: MessageRow; threadStatus: string };
    expect(out.message.authorKind).toBe('consumer');
    expect(out.threadStatus).toBe('open');
  });

  it('replies on a closed thread are rejected everywhere (409 question_closed)', async () => {
    const close = await app.inject({
      method: 'PATCH',
      url: `/v1/tenants/${tenantId}/questions/${publicThreadId}`,
      headers: bearer('owner'),
      payload: { status: 'closed' },
    });
    expect(close.statusCode).toBe(200);
    expect((close.json() as { status: string }).status).toBe('closed');

    const consumer = await app.inject({
      method: 'POST',
      url: `/v1/consumer/questions/${publicThreadId}/messages`,
      headers: bearer('asker'),
      payload: { body: 'one more thing' },
    });
    expect(consumer.statusCode).toBe(409);
    expect(consumer.json().error.code).toBe('question_closed');

    const org = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/questions/${publicThreadId}/messages`,
      headers: bearer('owner'),
      payload: { body: 'org necro' },
    });
    expect(org.statusCode).toBe(409);
    expect(org.json().error.code).toBe('question_closed');

    const admin = await app.inject({
      method: 'POST',
      url: `/v1/admin/questions/${publicThreadId}/messages`,
      headers: bearer('padmin'),
      payload: { body: 'admin necro' },
    });
    expect(admin.statusCode).toBe(409);
    expect(admin.json().error.code).toBe('question_closed');

    // Org reopens for the tests below.
    const reopen = await app.inject({
      method: 'PATCH',
      url: `/v1/tenants/${tenantId}/questions/${publicThreadId}`,
      headers: bearer('owner'),
      payload: { status: 'open' },
    });
    expect((reopen.json() as { status: string }).status).toBe('open');
  });

  it('author PATCH: answered/closed allowed, reopen of closed rejected, non-author 404', async () => {
    const answered = await app.inject({
      method: 'PATCH',
      url: `/v1/consumer/questions/${publicThreadId}`,
      headers: bearer('asker'),
      payload: { status: 'answered' },
    });
    expect(answered.statusCode).toBe(200);
    expect((answered.json() as { status: string }).status).toBe('answered');
    // PATCH responses carry the enriched thread (subject + authorName).
    expect((answered.json() as ThreadDetail['thread']).subject.name).toBe('QT Cup');
    expect((answered.json() as ThreadDetail['thread']).authorName).toBe('Member');

    const closed = await app.inject({
      method: 'PATCH',
      url: `/v1/consumer/questions/${publicThreadId}`,
      headers: bearer('asker'),
      payload: { status: 'closed' },
    });
    expect((closed.json() as { status: string }).status).toBe('closed');

    // closed → answered is a reopen; the author must ask again instead.
    const resurrect = await app.inject({
      method: 'PATCH',
      url: `/v1/consumer/questions/${publicThreadId}`,
      headers: bearer('asker'),
      payload: { status: 'answered' },
    });
    expect(resurrect.statusCode).toBe(409);
    expect(resurrect.json().error.code).toBe('question_closed');

    // `open` isn't even a valid author status value.
    const openReq = await app.inject({
      method: 'PATCH',
      url: `/v1/consumer/questions/${publicThreadId}`,
      headers: bearer('asker'),
      payload: { status: 'open' },
    });
    expect(openReq.statusCode).toBe(400);

    const nonAuthor = await app.inject({
      method: 'PATCH',
      url: `/v1/consumer/questions/${publicThreadId}`,
      headers: bearer('rando'),
      payload: { status: 'answered' },
    });
    expect(nonAuthor.statusCode).toBe(404);
    expect(nonAuthor.json().error.code).toBe('question_not_found');

    // Restore to open for the remaining tests.
    const reopen = await app.inject({
      method: 'PATCH',
      url: `/v1/tenants/${tenantId}/questions/${publicThreadId}`,
      headers: bearer('owner'),
      payload: { status: 'open' },
    });
    expect((reopen.json() as { status: string }).status).toBe('open');
  });

  // ── Org inbox + capabilities ───────────────────────────────────────────────

  it('org inbox lists both threads with subject summaries; filters work', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/questions`,
      headers: bearer('owner'),
    });
    expect(res.statusCode).toBe(200);
    const rows = (res.json() as ListPage).rows;
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(publicThreadId);
    expect(ids).toContain(privateThreadId);
    const priv = rows.find((r) => r.id === privateThreadId)!;
    expect(priv.subject).toEqual({ type: 'membership', id: membershipId, name: 'QT Gold' });

    const privOnly = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/questions?visibility=private`,
      headers: bearer('owner'),
    });
    expect((privOnly.json() as ListPage).rows.every((r) => r.visibility === 'private')).toBe(true);

    const summary = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/questions/summary`,
      headers: bearer('owner'),
    });
    expect(summary.statusCode).toBe(200);
    expect((summary.json() as { openCount: number }).openCount).toBeGreaterThanOrEqual(1);
  });

  it('non-members are denied the org inbox (403)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/questions`,
      headers: bearer('rando'),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('tenant_forbidden');
  });

  it('readonly members can read the inbox but cannot reply (403 forbidden_capability)', async () => {
    const list = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/questions`,
      headers: bearer('readonly'),
    });
    expect(list.statusCode).toBe(200);

    const reply = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/questions/${publicThreadId}/messages`,
      headers: bearer('readonly'),
      payload: { body: 'should not be allowed' },
    });
    expect(reply.statusCode).toBe(403);
    expect(reply.json().error.code).toBe('forbidden_capability');
  });

  it('threads of another tenant 404 on the partner surface', async () => {
    // The platform tenant is a valid tenant for padmin, but the thread belongs
    // to the org — padmin's own-tenant surface must not see it.
    const res = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/questions/00000000-0000-0000-0000-0000000000ab`,
      headers: bearer('owner'),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('question_not_found');
  });

  // ── Admin surface ──────────────────────────────────────────────────────────

  it('admin list sees both threads and filters by tenantId', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/questions?tenantId=${tenantId}`,
      headers: bearer('padmin'),
    });
    expect(res.statusCode).toBe(200);
    const ids = (res.json() as ListPage).rows.map((r) => r.id);
    expect(ids).toContain(publicThreadId);
    expect(ids).toContain(privateThreadId);
  });

  it('admin (non-platform user) is denied', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/questions',
      headers: bearer('rando'),
    });
    expect(res.statusCode).toBe(403);
  });

  it('admin reply stamps circls, shows the Circls badge name, and auto-answers', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/questions/${privateThreadId}/messages`,
      headers: bearer('padmin'),
      payload: { body: 'Circls here — the org can pause it from their side.' },
    });
    expect(res.statusCode).toBe(200);
    const out = res.json() as { message: MessageRow; threadStatus: string };
    expect(out.message.authorKind).toBe('circls');
    expect(out.message.authorName).toBe('Circls team');
    expect(out.threadStatus).toBe('answered');

    // The author sees the reply on their consumer surface.
    const detail = await app.inject({
      method: 'GET',
      url: `/v1/consumer/questions/${privateThreadId}`,
      headers: bearer('asker'),
    });
    const msgs = (detail.json() as ThreadDetail).messages;
    expect(msgs.some((m) => m.authorKind === 'circls')).toBe(true);
  });

  it('question.asked and question.replied ledger rows were written', async () => {
    const asked = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM notifications
      WHERE template_key = 'question.asked' AND recipient = ${'org_qt_' + RUN + '@x.com'}
    `);
    expect(firstRow<{ n: number }>(asked).n).toBeGreaterThanOrEqual(2);

    const replied = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM notifications
      WHERE template_key = 'question.replied' AND recipient = ${'asker_qt_' + RUN + '@x.com'}
    `);
    expect(firstRow<{ n: number }>(replied).n).toBeGreaterThanOrEqual(1);
  });

  // ── Moderation ─────────────────────────────────────────────────────────────

  it('org can hide a non-root reply on a public thread; visibility rules apply', async () => {
    const hide = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/questions/${publicThreadId}/messages/${randoReplyId}/hide`,
      headers: bearer('owner'),
      payload: {},
    });
    expect(hide.statusCode).toBe(200);
    expect((hide.json() as MessageRow).hiddenAt).not.toBeNull();
    expect((hide.json() as MessageRow).hiddenByKind).toBe('org');

    // Signed-out viewer: hidden message omitted.
    const anon = await app.inject({ method: 'GET', url: `/v1/consumer/questions/${publicThreadId}` });
    expect((anon.json() as ThreadDetail).messages.some((m) => m.id === randoReplyId)).toBe(false);

    // The hidden message's author still sees it (marked).
    const author = await app.inject({
      method: 'GET',
      url: `/v1/consumer/questions/${publicThreadId}`,
      headers: bearer('rando'),
    });
    const own = (author.json() as ThreadDetail).messages.find((m) => m.id === randoReplyId);
    expect(own).toBeDefined();
    expect(own!.hiddenAt).not.toBeNull();

    // Partner surface: marked, never omitted — with hiddenByKind + own flags.
    const org = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/questions/${publicThreadId}`,
      headers: bearer('owner'),
    });
    const orgDetail = org.json() as ThreadDetail;
    expect(orgDetail.thread.subject.name).toBe('QT Cup');
    expect(orgDetail.thread.authorName).toBe('Member');
    const marked = orgDetail.messages.find((m) => m.id === randoReplyId);
    expect(marked!.hiddenAt).not.toBeNull();
    expect(marked!.hiddenByKind).toBe('org');
    expect(marked!.own).toBe(false);
    // The owner's own org reply carries own=true on the staff surface.
    expect(orgDetail.messages.some((m) => m.authorKind === 'org' && m.own)).toBe(true);

    const unhide = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/questions/${publicThreadId}/messages/${randoReplyId}/unhide`,
      headers: bearer('owner'),
      payload: {},
    });
    expect(unhide.statusCode).toBe(200);
    expect((unhide.json() as MessageRow).hiddenAt).toBeNull();
    expect((unhide.json() as MessageRow).hiddenByKind).toBeNull();
  });

  it('org cannot unhide a circls-hidden message; hidden replies drop off public replyCount', async () => {
    const listBefore = await app.inject({
      method: 'GET',
      url: `/v1/consumer/questions?subjectType=event&subjectId=${eventId}`,
    });
    const rowBefore = (listBefore.json() as ListPage).rows.find((r) => r.id === publicThreadId)!;

    // Circls hides the rando reply (non-root).
    const hide = await app.inject({
      method: 'POST',
      url: `/v1/admin/questions/${publicThreadId}/messages/${randoReplyId}/hide`,
      headers: bearer('padmin'),
      payload: {},
    });
    expect(hide.statusCode).toBe(200);
    expect((hide.json() as MessageRow).hiddenByKind).toBe('circls');

    // The org can NOT undo a circls hide (moderation hierarchy).
    const orgUnhide = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/questions/${publicThreadId}/messages/${randoReplyId}/unhide`,
      headers: bearer('owner'),
      payload: {},
    });
    expect(orgUnhide.statusCode).toBe(403);
    expect(orgUnhide.json().error.code).toBe('forbidden_moderation');

    // Even an org re-hide must not launder the circls stamp into an org one.
    const orgRehide = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/questions/${publicThreadId}/messages/${randoReplyId}/hide`,
      headers: bearer('owner'),
      payload: {},
    });
    expect(orgRehide.statusCode).toBe(200);
    expect((orgRehide.json() as MessageRow).hiddenByKind).toBe('circls');

    // Public list replyCount counts only non-hidden replies.
    const listAfter = await app.inject({
      method: 'GET',
      url: `/v1/consumer/questions?subjectType=event&subjectId=${eventId}`,
    });
    const rowAfter = (listAfter.json() as ListPage).rows.find((r) => r.id === publicThreadId)!;
    expect(rowAfter.replyCount).toBe(rowBefore.replyCount - 1);

    // Circls can unhide anything.
    const unhide = await app.inject({
      method: 'POST',
      url: `/v1/admin/questions/${publicThreadId}/messages/${randoReplyId}/unhide`,
      headers: bearer('padmin'),
      payload: {},
    });
    expect(unhide.statusCode).toBe(200);
    expect((unhide.json() as MessageRow).hiddenAt).toBeNull();

    const listRestored = await app.inject({
      method: 'GET',
      url: `/v1/consumer/questions?subjectType=event&subjectId=${eventId}`,
    });
    const rowRestored = (listRestored.json() as ListPage).rows.find((r) => r.id === publicThreadId)!;
    expect(rowRestored.replyCount).toBe(rowBefore.replyCount);
  });

  it('org cannot hide the root message (400 cannot_hide_root)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/questions/${publicThreadId}/messages/${publicRootId}/hide`,
      headers: bearer('owner'),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('cannot_hide_root');
  });

  it('moderation is public-threads-only (400 not_public_thread)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/questions/${privateThreadId}/messages/${privateRootId}/hide`,
      headers: bearer('owner'),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('not_public_thread');
  });

  it('admin can hide the root: thread drops off the public list but stays for author/org/admin', async () => {
    const hide = await app.inject({
      method: 'POST',
      url: `/v1/admin/questions/${publicThreadId}/messages/${publicRootId}/hide`,
      headers: bearer('padmin'),
      payload: {},
    });
    expect(hide.statusCode).toBe(200);

    const pub = await app.inject({
      method: 'GET',
      url: `/v1/consumer/questions?subjectType=event&subjectId=${eventId}`,
    });
    expect((pub.json() as ListPage).rows.some((r) => r.id === publicThreadId)).toBe(false);

    // Author still sees the thread (root is their own message, marked hidden).
    const mine = await app.inject({
      method: 'GET',
      url: '/v1/consumer/questions/mine',
      headers: bearer('asker'),
    });
    expect((mine.json() as ListPage).rows.some((r) => r.id === publicThreadId)).toBe(true);
    const detail = await app.inject({
      method: 'GET',
      url: `/v1/consumer/questions/${publicThreadId}`,
      headers: bearer('asker'),
    });
    const root = (detail.json() as ThreadDetail).messages.find((m) => m.id === publicRootId);
    expect(root).toBeDefined();
    expect(root!.hiddenAt).not.toBeNull();

    // Anonymous viewers (and signed-in outsiders) get a 404 on the detail —
    // a root-hidden thread is fully delisted for the public, not just trimmed.
    const anon = await app.inject({ method: 'GET', url: `/v1/consumer/questions/${publicThreadId}` });
    expect(anon.statusCode).toBe(404);
    expect(anon.json().error.code).toBe('question_not_found');
    const outsider = await app.inject({
      method: 'GET',
      url: `/v1/consumer/questions/${publicThreadId}`,
      headers: bearer('rando'),
    });
    expect(outsider.statusCode).toBe(404);

    // Outsiders can't reply on a thread they can't see either.
    const outsiderReply = await app.inject({
      method: 'POST',
      url: `/v1/consumer/questions/${publicThreadId}/messages`,
      headers: bearer('rando'),
      payload: { body: 'replying into the void' },
    });
    expect(outsiderReply.statusCode).toBe(404);
    expect(outsiderReply.json().error.code).toBe('question_not_found');

    // Org cannot unhide the (admin-hidden) root.
    const orgUnhide = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/questions/${publicThreadId}/messages/${publicRootId}/unhide`,
      headers: bearer('owner'),
      payload: {},
    });
    expect(orgUnhide.statusCode).toBe(400);
    expect(orgUnhide.json().error.code).toBe('cannot_hide_root');

    // Admin unhide restores the public listing.
    const unhide = await app.inject({
      method: 'POST',
      url: `/v1/admin/questions/${publicThreadId}/messages/${publicRootId}/unhide`,
      headers: bearer('padmin'),
      payload: {},
    });
    expect(unhide.statusCode).toBe(200);
    const pubAgain = await app.inject({
      method: 'GET',
      url: `/v1/consumer/questions?subjectType=event&subjectId=${eventId}`,
    });
    expect((pubAgain.json() as ListPage).rows.some((r) => r.id === publicThreadId)).toBe(true);
  });

  // ── Pagination + rate limit ────────────────────────────────────────────────

  it('public list paginates with a stable cursor', async () => {
    // 8 more public threads on the event (asker now at 10 threads total).
    for (let i = 0; i < 8; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/consumer/questions',
        headers: bearer('asker'),
        payload: {
          subjectType: 'event',
          subjectId: eventId,
          visibility: 'public',
          body: `Pagination filler question number ${i}`,
        },
      });
      expect(res.statusCode).toBe(200);
      // Distinct last_message_at values keep the ms-precision cursor stable.
      await new Promise((r) => setTimeout(r, 5));
    }

    const page1 = await app.inject({
      method: 'GET',
      url: `/v1/consumer/questions?subjectType=event&subjectId=${eventId}&limit=5`,
    });
    const p1 = page1.json() as ListPage;
    expect(p1.rows).toHaveLength(5);
    expect(p1.nextCursor).not.toBeNull();

    const page2 = await app.inject({
      method: 'GET',
      url: `/v1/consumer/questions?subjectType=event&subjectId=${eventId}&limit=5&cursor=${encodeURIComponent(p1.nextCursor!)}`,
    });
    const p2 = page2.json() as ListPage;
    expect(p2.rows).toHaveLength(4); // 9 public threads total
    expect(p2.nextCursor).toBeNull();

    const ids1 = p1.rows.map((r) => r.id);
    const ids2 = p2.rows.map((r) => r.id);
    expect(ids1.filter((id) => ids2.includes(id))).toEqual([]);

    // Newest-activity-first ordering across the page boundary.
    const all = [...p1.rows, ...p2.rows];
    for (let i = 1; i < all.length; i++) {
      expect(all[i - 1]!.lastMessageAt >= all[i]!.lastMessageAt).toBe(true);
    }
  });

  it('malformed cursors are a 400 bad_request, not a 500', async () => {
    const cases = [
      'not-a-cursor',
      'garbage|also-garbage',
      `2026-07-18T10:00:00.000Z|not-a-uuid`,
      `un)parsable ts|${eventId}`,
      `2026-07-18T10:00:00.000Z; drop table question_threads|${eventId}`,
    ];
    for (const cursor of cases) {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/consumer/questions?subjectType=event&subjectId=${eventId}&cursor=${encodeURIComponent(cursor)}`,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('bad_request');
    }
  });

  it('11th thread in 24h is rate limited (429 question_rate_limited)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/consumer/questions',
      headers: bearer('asker'),
      payload: {
        subjectType: 'event',
        subjectId: eventId,
        visibility: 'public',
        body: 'One question too many for today.',
      },
    });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('question_rate_limited');
  });

  it('threads work on arenas too (tenant resolved via the venue)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/consumer/questions',
      headers: bearer('rando'),
      payload: {
        subjectType: 'arena',
        subjectId: arenaId,
        visibility: 'public',
        body: 'Is QT Court 1 indoors?',
      },
    });
    expect(res.statusCode).toBe(200);
    const detail = res.json() as ThreadDetail;
    expect(detail.thread.subjectType).toBe('arena');
    expect(detail.thread.tenantId).toBe(tenantId);
    expect(detail.thread.authorUserId).not.toBe(askerId);
    expect(detail.thread.subject).toEqual({ type: 'arena', id: arenaId, name: 'QT Court 1' });
  });

  it('cursor pagination is lossless across a sub-millisecond boundary', async () => {
    // Two more public arena threads, then force their activity timestamps into
    // the SAME millisecond, microseconds apart — a ms-truncated cursor would
    // skip the earlier one at the page boundary.
    const ids: string[] = [];
    for (const body of ['sub-ms boundary probe one', 'sub-ms boundary probe two']) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/consumer/questions',
        headers: bearer('rando'),
        payload: { subjectType: 'arena', subjectId: arenaId, visibility: 'public', body },
      });
      expect(res.statusCode).toBe(200);
      ids.push((res.json() as ThreadDetail).thread.id);
    }
    await db.execute(sql`
      UPDATE question_threads SET last_message_at = '2026-01-02 00:00:00.123456+00'::timestamptz
      WHERE id = ${ids[0]}::uuid
    `);
    await db.execute(sql`
      UPDATE question_threads SET last_message_at = '2026-01-02 00:00:00.123999+00'::timestamptz
      WHERE id = ${ids[1]}::uuid
    `);

    // Walk the whole arena list one row per page; every thread must appear
    // exactly once (no skips, no repeats), newest activity first.
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const url =
        `/v1/consumer/questions?subjectType=arena&subjectId=${arenaId}&limit=1` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
      const page = await app.inject({ method: 'GET', url });
      expect(page.statusCode).toBe(200);
      const body = page.json() as ListPage;
      seen.push(...body.rows.map((r) => r.id));
      cursor = body.nextCursor;
      if (cursor === null) break;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toContain(ids[0]!);
    expect(seen).toContain(ids[1]!);
    // The µs-later thread pages out strictly before the µs-earlier one.
    expect(seen.indexOf(ids[1]!)).toBeLessThan(seen.indexOf(ids[0]!));
  });

  // ── Archiving (thread-level moderation) ────────────────────────────────────

  let archThreadId: string;
  let archRootId: string;

  it('org archives a thread: it vanishes from every consumer surface', async () => {
    // A fresh public thread by rando (asker is at the thread rate limit).
    const created = await app.inject({
      method: 'POST',
      url: '/v1/consumer/questions',
      headers: bearer('rando'),
      payload: {
        subjectType: 'event',
        subjectId: eventId,
        visibility: 'public',
        body: 'Will the QT Cup final be livestreamed?',
      },
    });
    expect(created.statusCode).toBe(200);
    const createdDetail = created.json() as ThreadDetail;
    archThreadId = createdDetail.thread.id;
    archRootId = createdDetail.messages[0]!.id;
    // Consumer payloads never carry archive fields.
    expect('archivedAt' in createdDetail.thread).toBe(false);

    const summaryBefore = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/questions/summary`,
      headers: bearer('owner'),
    });
    const openBefore = (summaryBefore.json() as { openCount: number }).openCount;

    const archive = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/questions/${archThreadId}/archive`,
      headers: bearer('owner'),
      payload: {},
    });
    expect(archive.statusCode).toBe(200);
    const archived = archive.json() as ThreadDetail['thread'];
    expect(archived.id).toBe(archThreadId);
    expect(archived.archivedAt).not.toBeNull();
    expect(archived.archivedByKind).toBe('org');

    // The (open) thread no longer counts towards the partner summary.
    const summaryAfter = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/questions/summary`,
      headers: bearer('owner'),
    });
    expect((summaryAfter.json() as { openCount: number }).openCount).toBe(openBefore - 1);

    // Public list: gone.
    const pub = await app.inject({
      method: 'GET',
      url: `/v1/consumer/questions?subjectType=event&subjectId=${eventId}`,
    });
    expect((pub.json() as ListPage).rows.some((r) => r.id === archThreadId)).toBe(false);

    // Author detail: 404 — nonexistent even for the thread author.
    const authorDetail = await app.inject({
      method: 'GET',
      url: `/v1/consumer/questions/${archThreadId}`,
      headers: bearer('rando'),
    });
    expect(authorDetail.statusCode).toBe(404);
    expect(authorDetail.json().error.code).toBe('question_not_found');

    // Author reply: 404.
    const authorReply = await app.inject({
      method: 'POST',
      url: `/v1/consumer/questions/${archThreadId}/messages`,
      headers: bearer('rando'),
      payload: { body: 'hello? anyone?' },
    });
    expect(authorReply.statusCode).toBe(404);
    expect(authorReply.json().error.code).toBe('question_not_found');

    // Author status PATCH: 404.
    const authorPatch = await app.inject({
      method: 'PATCH',
      url: `/v1/consumer/questions/${archThreadId}`,
      headers: bearer('rando'),
      payload: { status: 'closed' },
    });
    expect(authorPatch.statusCode).toBe(404);
    expect(authorPatch.json().error.code).toBe('question_not_found');

    // Author /mine: excluded.
    const mine = await app.inject({
      method: 'GET',
      url: '/v1/consumer/questions/mine',
      headers: bearer('rando'),
    });
    expect((mine.json() as ListPage).rows.some((r) => r.id === archThreadId)).toBe(false);

    // Org members hitting the consumer endpoint still see it (staff parity) —
    // but the consumer payload carries no archive fields even for them.
    const orgView = await app.inject({
      method: 'GET',
      url: `/v1/consumer/questions/${archThreadId}`,
      headers: bearer('owner'),
    });
    expect(orgView.statusCode).toBe(200);
    expect('archivedAt' in (orgView.json() as ThreadDetail).thread).toBe(false);
  });

  it('staff mutations on an archived thread are rejected (409 question_archived)', async () => {
    const orgReply = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/questions/${archThreadId}/messages`,
      headers: bearer('owner'),
      payload: { body: 'replying into the archive' },
    });
    expect(orgReply.statusCode).toBe(409);
    expect(orgReply.json().error.code).toBe('question_archived');

    const orgStatus = await app.inject({
      method: 'PATCH',
      url: `/v1/tenants/${tenantId}/questions/${archThreadId}`,
      headers: bearer('owner'),
      payload: { status: 'closed' },
    });
    expect(orgStatus.statusCode).toBe(409);
    expect(orgStatus.json().error.code).toBe('question_archived');

    const orgHide = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/questions/${archThreadId}/messages/${archRootId}/hide`,
      headers: bearer('owner'),
      payload: {},
    });
    expect(orgHide.statusCode).toBe(409);
    expect(orgHide.json().error.code).toBe('question_archived');

    const adminReply = await app.inject({
      method: 'POST',
      url: `/v1/admin/questions/${archThreadId}/messages`,
      headers: bearer('padmin'),
      payload: { body: 'admin into the archive' },
    });
    expect(adminReply.statusCode).toBe(409);
    expect(adminReply.json().error.code).toBe('question_archived');

    const adminStatus = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/questions/${archThreadId}`,
      headers: bearer('padmin'),
      payload: { status: 'answered' },
    });
    expect(adminStatus.statusCode).toBe(409);
    expect(adminStatus.json().error.code).toBe('question_archived');
  });

  it('staff lists: default omits archived threads; archived=true returns them', async () => {
    const active = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/questions`,
      headers: bearer('owner'),
    });
    expect((active.json() as ListPage).rows.some((r) => r.id === archThreadId)).toBe(false);

    const archivedList = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/questions?archived=true`,
      headers: bearer('owner'),
    });
    const archRow = (archivedList.json() as ListPage).rows.find((r) => r.id === archThreadId);
    expect(archRow).toBeDefined();
    expect(archRow!.archivedAt).not.toBeNull();
    expect(archRow!.archivedByKind).toBe('org');

    // Staff detail carries the archive fields too.
    const detail = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/questions/${archThreadId}`,
      headers: bearer('owner'),
    });
    const dThread = (detail.json() as ThreadDetail).thread;
    expect(dThread.archivedAt).not.toBeNull();
    expect(dThread.archivedByKind).toBe('org');

    // Admin surface mirrors both views.
    const adminActive = await app.inject({
      method: 'GET',
      url: `/v1/admin/questions?tenantId=${tenantId}`,
      headers: bearer('padmin'),
    });
    expect((adminActive.json() as ListPage).rows.some((r) => r.id === archThreadId)).toBe(false);
    const adminArchived = await app.inject({
      method: 'GET',
      url: `/v1/admin/questions?tenantId=${tenantId}&archived=true`,
      headers: bearer('padmin'),
    });
    expect((adminArchived.json() as ListPage).rows.some((r) => r.id === archThreadId)).toBe(true);
  });

  it('org can unarchive its own archive; Circls archives are Circls-only', async () => {
    // Org undoes its own archive.
    const orgUnarchive = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/questions/${archThreadId}/unarchive`,
      headers: bearer('owner'),
      payload: {},
    });
    expect(orgUnarchive.statusCode).toBe(200);
    expect((orgUnarchive.json() as ThreadDetail['thread']).archivedAt).toBeNull();

    const pubRestored = await app.inject({
      method: 'GET',
      url: `/v1/consumer/questions?subjectType=event&subjectId=${eventId}`,
    });
    expect((pubRestored.json() as ListPage).rows.some((r) => r.id === archThreadId)).toBe(true);

    // Circls archives it.
    const adminArchive = await app.inject({
      method: 'POST',
      url: `/v1/admin/questions/${archThreadId}/archive`,
      headers: bearer('padmin'),
      payload: {},
    });
    expect(adminArchive.statusCode).toBe(200);
    expect((adminArchive.json() as ThreadDetail['thread']).archivedByKind).toBe('circls');

    // The org can NOT undo a Circls archive (moderation hierarchy).
    const orgUnarchiveDenied = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/questions/${archThreadId}/unarchive`,
      headers: bearer('owner'),
      payload: {},
    });
    expect(orgUnarchiveDenied.statusCode).toBe(403);
    expect(orgUnarchiveDenied.json().error.code).toBe('forbidden_moderation');

    // An org re-archive is a no-op that must NOT launder the Circls stamp.
    const orgRearchive = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/questions/${archThreadId}/archive`,
      headers: bearer('owner'),
      payload: {},
    });
    expect(orgRearchive.statusCode).toBe(200);
    expect((orgRearchive.json() as ThreadDetail['thread']).archivedByKind).toBe('circls');

    // Circls can always unarchive; the thread returns to the author.
    const adminUnarchive = await app.inject({
      method: 'POST',
      url: `/v1/admin/questions/${archThreadId}/unarchive`,
      headers: bearer('padmin'),
      payload: {},
    });
    expect(adminUnarchive.statusCode).toBe(200);
    expect((adminUnarchive.json() as ThreadDetail['thread']).archivedAt).toBeNull();

    const authorDetail = await app.inject({
      method: 'GET',
      url: `/v1/consumer/questions/${archThreadId}`,
      headers: bearer('rando'),
    });
    expect(authorDetail.statusCode).toBe(200);
    const mine = await app.inject({
      method: 'GET',
      url: '/v1/consumer/questions/mine',
      headers: bearer('rando'),
    });
    expect((mine.json() as ListPage).rows.some((r) => r.id === archThreadId)).toBe(true);
  });

  // ── Support intake + resolver context (2026-07-18 support→threads design) ──

  describe('support intake + resolver context', () => {
    interface ContextBooking {
      id: string;
      itemType: string;
      label: string;
      status: string;
      totalPaise: number | null;
      currency: string;
      paymentMethod: string;
      timeRange: { start: string; end: string } | null;
      createdAt: string;
    }
    interface ThreadContext {
      member: {
        id: string;
        displayName: string;
        memberSince: string;
        email?: string | null;
        phone?: string | null;
      };
      contextBooking: ContextBooking | null;
      recentBookings: ContextBooking[];
      memberships: { id: string; membershipId: string; name: string; status: string }[];
      priorThreads: { id: string; status: string; subject: { type: string; id: string | null; name: string }; lastMessageAt: string }[];
      recentActivity?: { id: string; eventType: string; createdAt: string }[];
      supportIssues?: { id: string; source: string; category: string | null; status: string; messageExcerpt: string; createdAt: string }[];
    }

    let bookerId: string;
    let slotBookingId: string;
    let eventBookingId: string;
    let membershipBookingId: string;
    let ghostBookingId: string;
    let cancelledBookingId: string;
    let otherUsersBookingId: string;
    const GHOST_EVENT_ID = '00000000-0000-0000-0000-00000000dead';

    let slotThreadId: string;
    let eventThreadId: string;
    let membershipThreadId: string;
    let ghostThreadId: string;
    let platformThreadId: string;

    const FLOW = [
      { question: 'What can we help you with?', answer: 'A booking issue' },
      { question: 'Which booking?', answer: 'My court booking' },
    ];

    beforeAll(async () => {
      const me = await app.inject({ method: 'GET', url: '/v1/consumer/me', headers: bearer('booker') });
      expect(me.statusCode).toBe(200);
      bookerId = (me.json() as { profile: { id: string } }).profile.id;

      // Bookings owned by booker, one per item type + edge cases. Inserted
      // directly (the full pay-and-book flow is out of scope here).
      const ins = async (q: SQL): Promise<string> =>
        firstRow<{ id: string }>(await db.execute<{ id: string }>(q)).id;

      slotBookingId = await ins(sql`
        INSERT INTO bookings (tenant_id, item_type, slot_arena_id, time_range, channel, payment_method, status, customer_user_id, total_paise, currency)
        VALUES (${tenantId}::uuid, 'slot', ${arenaId}::uuid,
                tstzrange(now() + interval '1 day', now() + interval '1 day 1 hour'),
                'circls', 'external', 'confirmed', ${bookerId}::uuid, 40000, 'INR')
        RETURNING id
      `);
      // Ownership via created_by_user_id (booked for someone else).
      eventBookingId = await ins(sql`
        INSERT INTO bookings (tenant_id, item_type, item_data, channel, payment_method, status, created_by_user_id, total_paise, currency)
        VALUES (${tenantId}::uuid, 'event', ${JSON.stringify({ eventId, eventName: 'QT Cup' })}::jsonb,
                'circls', 'free', 'confirmed', ${bookerId}::uuid, 0, 'INR')
        RETURNING id
      `);
      membershipBookingId = await ins(sql`
        INSERT INTO bookings (tenant_id, item_type, item_data, channel, payment_method, status, customer_user_id, total_paise, currency)
        VALUES (${tenantId}::uuid, 'membership', ${JSON.stringify({ membershipId })}::jsonb,
                'circls', 'external', 'confirmed', ${bookerId}::uuid, 150000, 'INR')
        RETURNING id
      `);
      // item_data points at an event row that no longer exists → general fallback.
      ghostBookingId = await ins(sql`
        INSERT INTO bookings (tenant_id, item_type, item_data, channel, payment_method, status, customer_user_id)
        VALUES (${tenantId}::uuid, 'event', ${JSON.stringify({ eventId: GHOST_EVENT_ID })}::jsonb,
                'circls', 'free', 'confirmed', ${bookerId}::uuid)
        RETURNING id
      `);
      // Cancelled booking on a REAL event — refund flows are about cancelled
      // bookings, so the intake must accept it (and route to the org tenant).
      cancelledBookingId = await ins(sql`
        INSERT INTO bookings (tenant_id, item_type, item_data, channel, payment_method, status, customer_user_id, total_paise, currency)
        VALUES (${tenantId}::uuid, 'event', ${JSON.stringify({ eventId, eventName: 'QT Cup' })}::jsonb,
                'circls', 'external', 'cancelled', ${bookerId}::uuid, 25000, 'INR')
        RETURNING id
      `);
      otherUsersBookingId = await ins(sql`
        INSERT INTO bookings (tenant_id, item_type, channel, payment_method, status, customer_user_id)
        VALUES (${tenantId}::uuid, 'event', 'circls', 'free', 'confirmed', ${askerId}::uuid)
        RETURNING id
      `);

      // Relationship rows for the context panel: an active membership,
      // consumer activity, and a historical support issue.
      await db.execute(sql`
        INSERT INTO user_memberships (user_id, membership_id, starts_at, ends_at, status)
        VALUES (${bookerId}::uuid, ${membershipId}::uuid, now() - interval '5 days', now() + interval '25 days', 'active')
      `);
      await db.execute(sql`
        INSERT INTO consumer_activity (user_id, event_type, item_type, item_id, client_ts)
        VALUES (${bookerId}::uuid, 'screen_view', NULL, NULL, now() - interval '2 hours'),
               (${bookerId}::uuid, 'item_view', 'event', ${eventId}::uuid, now() - interval '1 hour')
      `);
      await db.execute(sql`
        INSERT INTO support_issues (user_id, message, source, category)
        VALUES (${bookerId}::uuid, 'Historical concern from the old chatbot intake.', 'consumer_chatbot', 'payment')
      `);
    });

    it('slot-booking intake → private arena thread, origin/category on the consumer payload only', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/consumer/questions',
        headers: bearer('booker'),
        payload: {
          origin: 'support',
          category: 'booking_issue',
          bookingId: slotBookingId,
          flowAnswers: FLOW,
          body: 'My court booking shows the wrong start time.',
        },
      });
      expect(res.statusCode).toBe(200);
      const detail = res.json() as ThreadDetail;
      slotThreadId = detail.thread.id;
      expect(detail.thread.subjectType).toBe('arena');
      expect(detail.thread.subjectId).toBe(arenaId);
      expect(detail.thread.subject).toEqual({ type: 'arena', id: arenaId, name: 'QT Court 1' });
      expect(detail.thread.tenantId).toBe(tenantId);
      expect(detail.thread.visibility).toBe('private');
      expect(detail.thread.origin).toBe('support');
      expect(detail.thread.category).toBe('booking_issue');
      expect(detail.thread.status).toBe('open');
      // Consumer payloads never expose the pinned booking or the transcript.
      expect('contextBookingId' in detail.thread).toBe(false);
      expect('flowAnswers' in detail.thread).toBe(false);

      // Staff detail carries the full support context.
      const staff = await app.inject({
        method: 'GET',
        url: `/v1/tenants/${tenantId}/questions/${slotThreadId}`,
        headers: bearer('owner'),
      });
      const staffThread = (staff.json() as ThreadDetail).thread;
      expect(staffThread.origin).toBe('support');
      expect(staffThread.category).toBe('booking_issue');
      expect(staffThread.contextBookingId).toBe(slotBookingId);
      expect(staffThread.flowAnswers).toEqual(FLOW);
    });

    it('event-booking intake (created_by ownership) → event thread', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/consumer/questions',
        headers: bearer('booker'),
        payload: {
          origin: 'support',
          category: 'refund_request',
          bookingId: eventBookingId,
          body: 'I need a refund for the QT Cup tickets.',
        },
      });
      expect(res.statusCode).toBe(200);
      const detail = res.json() as ThreadDetail;
      eventThreadId = detail.thread.id;
      expect(detail.thread.subjectType).toBe('event');
      expect(detail.thread.subjectId).toBe(eventId);
      expect(detail.thread.tenantId).toBe(tenantId);
      expect(detail.thread.visibility).toBe('private');
      expect(detail.thread.origin).toBe('support');
      expect(detail.thread.category).toBe('refund_request');
    });

    it('membership-booking intake → membership thread', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/consumer/questions',
        headers: bearer('booker'),
        payload: {
          origin: 'support',
          category: 'payment',
          bookingId: membershipBookingId,
          body: 'I was charged twice for QT Gold.',
        },
      });
      expect(res.statusCode).toBe(200);
      const detail = res.json() as ThreadDetail;
      membershipThreadId = detail.thread.id;
      expect(detail.thread.subjectType).toBe('membership');
      expect(detail.thread.subjectId).toBe(membershipId);
      expect(detail.thread.subject.name).toBe('QT Gold');
      expect(detail.thread.tenantId).toBe(tenantId);
      expect(detail.thread.visibility).toBe('private');
    });

    it('booking whose subject row is gone → general thread under the booking tenant', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/consumer/questions',
        headers: bearer('booker'),
        payload: {
          origin: 'support',
          category: 'booking_issue',
          bookingId: ghostBookingId,
          body: 'The event I booked has vanished from the app.',
        },
      });
      expect(res.statusCode).toBe(200);
      const detail = res.json() as ThreadDetail;
      ghostThreadId = detail.thread.id;
      expect(detail.thread.subjectType).toBe('general');
      expect(detail.thread.subjectId).toBeNull();
      expect(detail.thread.subject).toEqual({ type: 'general', id: null, name: 'General' });
      expect(detail.thread.tenantId).toBe(tenantId);
      expect(detail.thread.visibility).toBe('private');

      // The org still sees it (the booking is theirs), pinned booking intact.
      const staff = await app.inject({
        method: 'GET',
        url: `/v1/tenants/${tenantId}/questions/${ghostThreadId}`,
        headers: bearer('owner'),
      });
      expect(staff.statusCode).toBe(200);
      expect((staff.json() as ThreadDetail).thread.contextBookingId).toBe(ghostBookingId);
    });

    it('no-booking intake → general thread under the platform tenant, invisible to orgs + public', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/consumer/questions',
        headers: bearer('booker'),
        payload: {
          origin: 'support',
          category: 'other',
          flowAnswers: [{ question: 'What can we help you with?', answer: 'Something else' }],
          body: 'How do I change the email on my account?',
        },
      });
      expect(res.statusCode).toBe(200);
      const detail = res.json() as ThreadDetail;
      platformThreadId = detail.thread.id;
      expect(detail.thread.subjectType).toBe('general');
      expect(detail.thread.tenantId).toBe(platformTenantId);
      expect(detail.thread.visibility).toBe('private');
      expect(detail.thread.origin).toBe('support');

      // /mine shows it to the asker, with the general subject summary.
      const mine = await app.inject({
        method: 'GET',
        url: '/v1/consumer/questions/mine',
        headers: bearer('booker'),
      });
      const mineRow = (mine.json() as ListPage).rows.find((r) => r.id === platformThreadId);
      expect(mineRow).toBeDefined();
      expect(mineRow!.subject).toEqual({ type: 'general', id: null, name: 'General' });
      expect(mineRow!.origin).toBe('support');
      expect(mineRow!.category).toBe('other');

      // The org inbox of a NORMAL tenant never sees platform-general threads.
      const orgInbox = await app.inject({
        method: 'GET',
        url: `/v1/tenants/${tenantId}/questions`,
        headers: bearer('owner'),
      });
      expect((orgInbox.json() as ListPage).rows.some((r) => r.id === platformThreadId)).toBe(false);

      // Not on any public surface: private → outsiders 404 on the detail.
      const outsider = await app.inject({
        method: 'GET',
        url: `/v1/consumer/questions/${platformThreadId}`,
        headers: bearer('rando'),
      });
      expect(outsider.statusCode).toBe(404);

      // Admin sees it (platform tenant), with the support fields.
      const adminList = await app.inject({
        method: 'GET',
        url: `/v1/admin/questions?tenantId=${platformTenantId}`,
        headers: bearer('padmin'),
      });
      const adminRow = (adminList.json() as ListPage).rows.find((r) => r.id === platformThreadId);
      expect(adminRow).toBeDefined();
      expect(adminRow!.subjectType).toBe('general');
      expect(adminRow!.origin).toBe('support');
      expect(adminRow!.contextBookingId).toBeNull();
    });

    it('cancelled booking accepted → context pinned + routed to the booking tenant', async () => {
      // Product decision: refund concerns are precisely about cancelled
      // bookings — rejecting them would strand the user AND mis-route the
      // thread to the platform tenant instead of the org that owes the refund.
      const res = await app.inject({
        method: 'POST',
        url: '/v1/consumer/questions',
        headers: bearer('booker'),
        payload: {
          origin: 'support',
          category: 'refund_request',
          bookingId: cancelledBookingId,
          body: 'My QT Cup booking was cancelled — where is my refund?',
        },
      });
      expect(res.statusCode).toBe(200);
      const detail = res.json() as ThreadDetail;
      expect(detail.thread.subjectType).toBe('event');
      expect(detail.thread.subjectId).toBe(eventId);
      expect(detail.thread.tenantId).toBe(tenantId);
      expect(detail.thread.visibility).toBe('private');
      expect(detail.thread.category).toBe('refund_request');

      // The org sees it with the cancelled booking pinned.
      const staff = await app.inject({
        method: 'GET',
        url: `/v1/tenants/${tenantId}/questions/${detail.thread.id}`,
        headers: bearer('owner'),
      });
      expect(staff.statusCode).toBe(200);
      expect((staff.json() as ThreadDetail).thread.contextBookingId).toBe(cancelledBookingId);
    });

    it('rejects other users’ bookings (404 booking_not_found)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/consumer/questions',
        headers: bearer('booker'),
        payload: {
          origin: 'support',
          category: 'booking_issue',
          bookingId: otherUsersBookingId,
          body: 'trying to attach a booking that is not attachable',
        },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('booking_not_found');
    });

    it('subject row from a different tenant than the booking → general fallback', async () => {
      // Belt-and-braces in deriveSubjectFromBooking: item_data pointing at a
      // listing of ANOTHER tenant must not pin that listing — the thread falls
      // back to general under the booking's own tenant.
      const mismatch = firstRow<{ id: string }>(await db.execute<{ id: string }>(sql`
        INSERT INTO bookings (tenant_id, item_type, item_data, channel, payment_method, status, customer_user_id)
        VALUES (${platformTenantId}::uuid, 'event', ${JSON.stringify({ eventId })}::jsonb,
                'circls', 'free', 'confirmed', ${bookerId}::uuid)
        RETURNING id
      `)).id;
      const res = await app.inject({
        method: 'POST',
        url: '/v1/consumer/questions',
        headers: bearer('booker'),
        payload: {
          origin: 'support',
          category: 'other',
          bookingId: mismatch,
          body: 'booking whose item_data points at another tenant’s event',
        },
      });
      expect(res.statusCode).toBe(200);
      const detail = res.json() as ThreadDetail;
      expect(detail.thread.subjectType).toBe('general');
      expect(detail.thread.subjectId).toBeNull();
      expect(detail.thread.tenantId).toBe(platformTenantId);

      // The pinned booking survives the fallback (admin surface).
      const adminDetail = await app.inject({
        method: 'GET',
        url: `/v1/admin/questions/${detail.thread.id}`,
        headers: bearer('padmin'),
      });
      expect(adminDetail.statusCode).toBe(200);
      expect((adminDetail.json() as ThreadDetail).thread.contextBookingId).toBe(mismatch);
    });

    it('intake shapes are strict: forum and support fields cannot mix', async () => {
      // Forum shape with support-only fields → 400.
      const forumMix = await app.inject({
        method: 'POST',
        url: '/v1/consumer/questions',
        headers: bearer('booker'),
        payload: {
          subjectType: 'event',
          subjectId: eventId,
          visibility: 'public',
          body: 'sneaking a category into the forum shape',
          category: 'other',
        },
      });
      expect(forumMix.statusCode).toBe(400);
      expect(forumMix.json().error.code).toBe('bad_request');

      // Support shape with forum-only fields → 400 (subject/visibility are
      // server-derived on the support path).
      for (const extra of [
        { subjectType: 'event', subjectId: eventId },
        { visibility: 'public' },
      ]) {
        const supportMix = await app.inject({
          method: 'POST',
          url: '/v1/consumer/questions',
          headers: bearer('booker'),
          payload: {
            origin: 'support',
            category: 'other',
            body: 'trying to pick my own subject/visibility',
            ...extra,
          },
        });
        expect(supportMix.statusCode).toBe(400);
        expect(supportMix.json().error.code).toBe('bad_request');
      }
    });

    it('origin filter works on both staff lists', async () => {
      const partnerSupport = await app.inject({
        method: 'GET',
        url: `/v1/tenants/${tenantId}/questions?origin=support`,
        headers: bearer('owner'),
      });
      const supportRows = (partnerSupport.json() as ListPage).rows;
      expect(supportRows.length).toBeGreaterThanOrEqual(4);
      expect(supportRows.every((r) => r.origin === 'support')).toBe(true);
      expect(supportRows.some((r) => r.id === slotThreadId)).toBe(true);
      expect(supportRows.some((r) => r.id === publicThreadId)).toBe(false);

      const partnerForum = await app.inject({
        method: 'GET',
        url: `/v1/tenants/${tenantId}/questions?origin=forum`,
        headers: bearer('owner'),
      });
      const forumRows = (partnerForum.json() as ListPage).rows;
      expect(forumRows.every((r) => r.origin === 'forum')).toBe(true);
      expect(forumRows.some((r) => r.id === publicThreadId)).toBe(true);
      expect(forumRows.some((r) => r.id === slotThreadId)).toBe(false);

      const adminSupport = await app.inject({
        method: 'GET',
        url: `/v1/admin/questions?origin=support`,
        headers: bearer('padmin'),
      });
      const adminRows = (adminSupport.json() as ListPage).rows;
      expect(adminRows.every((r) => r.origin === 'support')).toBe(true);
      expect(adminRows.some((r) => r.id === platformThreadId)).toBe(true);
      const adminForum = await app.inject({
        method: 'GET',
        url: `/v1/admin/questions?origin=forum&tenantId=${tenantId}`,
        headers: bearer('padmin'),
      });
      expect((adminForum.json() as ListPage).rows.some((r) => r.id === slotThreadId)).toBe(false);
    });

    it('partner context: member + pinned booking + tenant-scoped relationship lists', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/tenants/${tenantId}/questions/${slotThreadId}/context`,
        headers: bearer('owner'),
      });
      expect(res.statusCode).toBe(200);
      const ctx = res.json() as ThreadContext;

      expect(ctx.member.id).toBe(bookerId);
      expect(ctx.member.displayName).toBe('Member');
      expect(ctx.member.memberSince).toBeTruthy();
      // Private thread → contact details included on the partner surface.
      expect(ctx.member.email).toBe(`booker_qt_${RUN}@x.com`);

      expect(ctx.contextBooking).not.toBeNull();
      expect(ctx.contextBooking!.id).toBe(slotBookingId);
      expect(ctx.contextBooking!.itemType).toBe('slot');
      expect(ctx.contextBooking!.label).toBe('QT Court 1');
      expect(ctx.contextBooking!.status).toBe('confirmed');
      expect(ctx.contextBooking!.totalPaise).toBe(40000);
      expect(ctx.contextBooking!.currency).toBe('INR');
      expect(ctx.contextBooking!.paymentMethod).toBe('external');
      expect(ctx.contextBooking!.timeRange).not.toBeNull();

      const bookingIds = ctx.recentBookings.map((b) => b.id);
      expect(bookingIds).toContain(slotBookingId);
      expect(bookingIds).toContain(eventBookingId);
      expect(bookingIds).toContain(membershipBookingId);
      expect(bookingIds).not.toContain(otherUsersBookingId);
      const eventRow = ctx.recentBookings.find((b) => b.id === eventBookingId)!;
      expect(eventRow.label).toBe('QT Cup');
      const membershipRow = ctx.recentBookings.find((b) => b.id === membershipBookingId)!;
      expect(membershipRow.label).toBe('QT Gold');

      expect(ctx.memberships).toHaveLength(1);
      expect(ctx.memberships[0]!.name).toBe('QT Gold');
      expect(ctx.memberships[0]!.status).toBe('active');

      // Prior threads: booker's other threads with THIS tenant — the
      // platform-tenant general thread must NOT leak into the org's panel.
      const priorIds = ctx.priorThreads.map((p) => p.id);
      expect(priorIds).not.toContain(slotThreadId);
      expect(priorIds).toContain(eventThreadId);
      expect(priorIds).toContain(membershipThreadId);
      expect(priorIds).toContain(ghostThreadId);
      expect(priorIds).not.toContain(platformThreadId);

      // Partner-only extras stay admin-only.
      expect(ctx.recentActivity).toBeUndefined();
      expect(ctx.supportIssues).toBeUndefined();
    });

    it('partner context: tenant scoping 404s and contact details are private-only', async () => {
      // A thread belonging to ANOTHER tenant (the platform-general thread)
      // 404s on this org's surface — no cross-tenant leak.
      const wrongTenant = await app.inject({
        method: 'GET',
        url: `/v1/tenants/${tenantId}/questions/${platformThreadId}/context`,
        headers: bearer('owner'),
      });
      expect(wrongTenant.statusCode).toBe(404);
      expect(wrongTenant.json().error.code).toBe('question_not_found');

      // Non-members are denied outright.
      const nonMember = await app.inject({
        method: 'GET',
        url: `/v1/tenants/${tenantId}/questions/${slotThreadId}/context`,
        headers: bearer('rando'),
      });
      expect(nonMember.statusCode).toBe(403);

      // Public thread → no contact details on the partner surface.
      const pub = await app.inject({
        method: 'GET',
        url: `/v1/tenants/${tenantId}/questions/${publicThreadId}/context`,
        headers: bearer('owner'),
      });
      expect(pub.statusCode).toBe(200);
      const ctx = pub.json() as ThreadContext;
      expect('email' in ctx.member).toBe(false);
      expect('phone' in ctx.member).toBe(false);
    });

    it('admin context: cross-tenant lists + activity/support-issue extras + contact always', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/admin/questions/${slotThreadId}/context`,
        headers: bearer('padmin'),
      });
      expect(res.statusCode).toBe(200);
      const ctx = res.json() as ThreadContext;

      expect(ctx.member.id).toBe(bookerId);
      expect(ctx.member.email).toBe(`booker_qt_${RUN}@x.com`);

      // Cross-tenant prior threads: the platform-general thread appears here.
      const priorIds = ctx.priorThreads.map((p) => p.id);
      expect(priorIds).toContain(platformThreadId);
      expect(priorIds).not.toContain(slotThreadId);

      expect(ctx.recentActivity).toBeDefined();
      expect(ctx.recentActivity!.length).toBeGreaterThanOrEqual(2);
      expect(ctx.recentActivity!.some((a) => a.eventType === 'item_view')).toBe(true);

      expect(ctx.supportIssues).toBeDefined();
      expect(ctx.supportIssues!.length).toBeGreaterThanOrEqual(1);
      expect(ctx.supportIssues![0]!.source).toBe('consumer_chatbot');
      expect(ctx.supportIssues![0]!.category).toBe('payment');
      expect(ctx.supportIssues![0]!.messageExcerpt).toContain('Historical concern');

      // Admin contact details even on PUBLIC threads.
      const pub = await app.inject({
        method: 'GET',
        url: `/v1/admin/questions/${publicThreadId}/context`,
        headers: bearer('padmin'),
      });
      const pubCtx = pub.json() as ThreadContext;
      expect(pubCtx.member.email).toBe(`asker_qt_${RUN}@x.com`);
    });

    it('forum threads keep origin=forum and a null category everywhere', async () => {
      const detail = await app.inject({
        method: 'GET',
        url: `/v1/consumer/questions/${publicThreadId}`,
      });
      const thread = (detail.json() as ThreadDetail).thread;
      expect(thread.origin).toBe('forum');
      expect(thread.category).toBeNull();

      const pubList = await app.inject({
        method: 'GET',
        url: `/v1/consumer/questions?subjectType=event&subjectId=${eventId}`,
      });
      const row = (pubList.json() as ListPage).rows.find((r) => r.id === publicThreadId)!;
      expect(row.origin).toBe('forum');
      expect(row.category).toBeNull();
    });
  });
});
