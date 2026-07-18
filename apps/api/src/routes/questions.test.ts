import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
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
      owner: { uid: `fbuid_owner_qt_${RUN}`, email: `owner_qt_${RUN}@x.com`, email_verified: true },
      readonly: { uid: `fbuid_readonly_qt_${RUN}`, email: `readonly_qt_${RUN}@x.com`, email_verified: true },
      asker: { uid: `fbuid_asker_qt_${RUN}`, email: `asker_qt_${RUN}@x.com`, email_verified: true },
      rando: { uid: `fbuid_rando_qt_${RUN}`, email: `rando_qt_${RUN}@x.com`, email_verified: true },
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
  subjectId: string;
  tenantId: string;
  visibility: string;
  status: string;
  rootBody: string;
  replyCount: number;
  authorName: string;
  lastMessageAt: string;
  createdAt: string;
  subject?: { type: string; id: string; name: string };
}

interface MessageRow {
  id: string;
  threadId: string;
  authorKind: string;
  authorName: string;
  body: string;
  hiddenAt: string | null;
  createdAt: string;
}

interface ThreadDetail {
  thread: {
    id: string;
    subjectType: string;
    subjectId: string;
    tenantId: string;
    visibility: string;
    status: string;
    authorUserId: string;
    messageCount: number;
    lastMessageAt: string;
    createdAt: string;
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
    const platformTenantId = firstRow<{ id: string }>(ptRows).id;
    await db.execute(sql`
      INSERT INTO tenant_members (tenant_id, user_id, role)
      VALUES (${platformTenantId}::uuid, ${padminId}::uuid, 'manager')
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
    expect(detail.messages).toHaveLength(1);
    expect(detail.messages[0]!.authorKind).toBe('consumer');
    expect(detail.messages[0]!.authorName).toBe('Member');
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

  it('signed-out visitor can read the public thread', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/consumer/questions/${publicThreadId}`,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as ThreadDetail).messages).toHaveLength(1);
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

    // Partner surface: marked, never omitted.
    const org = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/questions/${publicThreadId}`,
      headers: bearer('owner'),
    });
    const marked = (org.json() as ThreadDetail).messages.find((m) => m.id === randoReplyId);
    expect(marked!.hiddenAt).not.toBeNull();

    const unhide = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/questions/${publicThreadId}/messages/${randoReplyId}/unhide`,
      headers: bearer('owner'),
      payload: {},
    });
    expect(unhide.statusCode).toBe(200);
    expect((unhide.json() as MessageRow).hiddenAt).toBeNull();
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

    // Anonymous viewers can still open the thread but the root is omitted.
    const anon = await app.inject({ method: 'GET', url: `/v1/consumer/questions/${publicThreadId}` });
    expect((anon.json() as ThreadDetail).messages.some((m) => m.id === publicRootId)).toBe(false);

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
  });
});
