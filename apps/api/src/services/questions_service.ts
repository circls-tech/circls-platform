/**
 * Questions threads service (design doc: docs/superpowers/specs/
 * 2026-07-18-questions-threads-design.md). Consumers ask questions on events,
 * arenas, or memberships; each question is a thread of chat-style messages
 * with an immutable public/private visibility and an open → answered → closed
 * lifecycle. This module owns all DB access + authz-adjacent lookups; the
 * pure transition/author-kind rules live in questions_transitions.ts.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  questionMessages,
  type QuestionAuthorKind,
  type QuestionMessage,
} from '../db/schema/question_messages.js';
import {
  questionThreads,
  type QuestionStatus,
  type QuestionSubjectType,
  type QuestionThread,
  type QuestionVisibility,
} from '../db/schema/question_threads.js';
import { tenants } from '../db/schema/tenants.js';
import { users } from '../db/schema/users.js';
import { BadRequest, Conflict, NotFound, RateLimit } from '../lib/errors.js';
import { onQuestionAsked, onQuestionReplied } from './notification_hooks.js';
import {
  applyAuthorStatusPatch,
  nextStatusOnReply,
  resolveAuthorKind,
  type AuthorPatchStatus,
} from './questions_transitions.js';

// ── Limits (design doc §3) ────────────────────────────────────────────────────

/** Max new threads per user per trailing 24h. */
const THREAD_RATE_LIMIT_24H = 10;
/** Max messages (root included) per user per trailing 24h. */
const MESSAGE_RATE_LIMIT_24H = 60;
/** Chars of the root message shown in list rows. */
const EXCERPT_LEN = 280;

// ── Serialized shapes ─────────────────────────────────────────────────────────

export interface QuestionSubjectSummary {
  type: QuestionSubjectType;
  id: string;
  name: string;
}

export interface QuestionThreadListRow {
  id: string;
  subjectType: QuestionSubjectType;
  subjectId: string;
  tenantId: string;
  visibility: QuestionVisibility;
  status: QuestionStatus;
  /** Excerpt (first 280 chars) of the root message. */
  rootBody: string;
  replyCount: number;
  authorName: string;
  lastMessageAt: string;
  createdAt: string;
  /** Partner/admin lists only. */
  subject?: QuestionSubjectSummary;
}

export interface QuestionMessageRow {
  id: string;
  threadId: string;
  authorKind: QuestionAuthorKind;
  authorName: string;
  body: string;
  /** Set only when the message is hidden AND the viewer may see it marked. */
  hiddenAt: string | null;
  createdAt: string;
}

export interface QuestionThreadDetail {
  thread: {
    id: string;
    subjectType: QuestionSubjectType;
    subjectId: string;
    tenantId: string;
    visibility: QuestionVisibility;
    status: QuestionStatus;
    authorUserId: string;
    messageCount: number;
    lastMessageAt: string;
    createdAt: string;
  };
  messages: QuestionMessageRow[];
}

export interface QuestionThreadListPage {
  rows: QuestionThreadListRow[];
  nextCursor: string | null;
}

// ── Small shared helpers ──────────────────────────────────────────────────────

function excerpt(body: string): string {
  return body.length > EXCERPT_LEN ? body.slice(0, EXCERPT_LEN) : body;
}

function subjectIdOf(t: Pick<QuestionThread, 'eventId' | 'arenaId' | 'membershipId'>): string {
  // The DB CHECK guarantees exactly one is set.
  return (t.eventId ?? t.arenaId ?? t.membershipId)!;
}

function authorName(
  kind: QuestionAuthorKind,
  displayName: string | null,
  tenantName: string,
): string {
  if (kind === 'circls') return 'Circls team';
  if (kind === 'org') return tenantName;
  return displayName ?? 'Member';
}

function threadNotFound(): never {
  throw new NotFound('Question not found', 'question_not_found');
}

/** Cursor = `${lastMessageAtIso}|${id}` (webhook deliveries convention). */
function parseCursor(cursor: string | undefined): { ts: string; id: string } | null {
  if (!cursor) return null;
  const idx = cursor.lastIndexOf('|');
  if (idx <= 0) return null;
  return { ts: cursor.slice(0, idx), id: cursor.slice(idx + 1) };
}

function clampLimit(limit: number | undefined): number {
  return Math.min(limit ?? 20, 50);
}

/** postgres-js returns raw rows for db.execute — normalize + narrow. */
function rowsOf(res: unknown): Record<string, unknown>[] {
  return res as unknown as Record<string, unknown>[];
}

function isoOf(v: unknown): string {
  return v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
}

// ── Viewer relationship ───────────────────────────────────────────────────────

export interface ViewerRelation {
  isPlatformMember: boolean;
  isOrgMember: boolean;
}

/**
 * A single query answering both membership questions for author_kind stamping
 * and hidden-message visibility. Checks `is_platform` directly (not the cached
 * platform-tenant id) so it degrades safely when the platform tenant isn't
 * bootstrapped.
 */
export async function resolveViewerRelation(
  userId: string,
  tenantId: string,
): Promise<ViewerRelation> {
  const res = await db.execute<Record<string, unknown>>(sql`
    select bool_or(t.is_platform)                       as is_platform_member,
           bool_or(tm.tenant_id = ${tenantId}::uuid)    as is_org_member
      from tenant_members tm
      join tenants t on t.id = tm.tenant_id
     where tm.user_id = ${userId}::uuid
  `);
  const r = rowsOf(res)[0] ?? {};
  return {
    isPlatformMember: Boolean(r['is_platform_member']),
    isOrgMember: Boolean(r['is_org_member']),
  };
}

// ── Subject validation (POST /v1/consumer/questions) ─────────────────────────

interface ResolvedSubject {
  tenantId: string;
  name: string;
}

/**
 * Validate the subject exists and is publicly visible, mirroring the
 * consumer_service browse rules: event `published` (+ tenant active + venue
 * active-or-none), arena `active` (+ venue active + tenant active), membership
 * `active` (+ tenant active + venue active-or-none). Resolves the owning
 * tenant (arena → its venue's tenant).
 */
export async function resolveVisibleSubject(
  subjectType: QuestionSubjectType,
  subjectId: string,
): Promise<ResolvedSubject> {
  if (subjectType === 'event') {
    const res = await db.execute<Record<string, unknown>>(sql`
      select e.tenant_id as tenant_id, e.name as name
        from events e
        join tenants tn on tn.id = e.tenant_id
        left join venues v on v.id = e.venue_id
       where e.id = ${subjectId}::uuid
         and e.status = 'published'
         and tn.status = 'active'
         and (e.venue_id is null or v.status = 'active')
       limit 1
    `);
    const r = rowsOf(res)[0];
    if (!r) throw new NotFound('Event not found', 'event_not_found');
    return { tenantId: r['tenant_id'] as string, name: r['name'] as string };
  }
  if (subjectType === 'arena') {
    const res = await db.execute<Record<string, unknown>>(sql`
      select v.tenant_id as tenant_id, a.name as name
        from arenas a
        join venues v on v.id = a.venue_id
        join tenants tn on tn.id = v.tenant_id
       where a.id = ${subjectId}::uuid
         and a.status = 'active'
         and v.status = 'active'
         and tn.status = 'active'
       limit 1
    `);
    const r = rowsOf(res)[0];
    if (!r) throw new NotFound('Arena not found', 'arena_not_found');
    return { tenantId: r['tenant_id'] as string, name: r['name'] as string };
  }
  const res = await db.execute<Record<string, unknown>>(sql`
    select m.tenant_id as tenant_id, m.name as name
      from memberships m
      join tenants tn on tn.id = m.tenant_id
      left join venues v on v.id = m.venue_id
     where m.id = ${subjectId}::uuid
       and m.status = 'active'
       and tn.status = 'active'
       and (m.venue_id is null or v.status = 'active')
     limit 1
  `);
  const r = rowsOf(res)[0];
  if (!r) throw new NotFound('Membership not found', 'membership_not_found');
  return { tenantId: r['tenant_id'] as string, name: r['name'] as string };
}

// ── Rate limits ───────────────────────────────────────────────────────────────

async function assertThreadRateLimit(userId: string): Promise<void> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(questionThreads)
    .where(
      and(
        eq(questionThreads.authorUserId, userId),
        sql`${questionThreads.createdAt} > now() - interval '24 hours'`,
      ),
    );
  if ((row?.n ?? 0) >= THREAD_RATE_LIMIT_24H) {
    throw new RateLimit(
      'Too many questions in the last 24 hours — try again later',
      'question_rate_limited',
    );
  }
}

async function assertMessageRateLimit(userId: string): Promise<void> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(questionMessages)
    .where(
      and(
        eq(questionMessages.authorUserId, userId),
        sql`${questionMessages.createdAt} > now() - interval '24 hours'`,
      ),
    );
  if ((row?.n ?? 0) >= MESSAGE_RATE_LIMIT_24H) {
    throw new RateLimit(
      'Too many messages in the last 24 hours — try again later',
      'question_rate_limited',
    );
  }
}

// ── Create thread ─────────────────────────────────────────────────────────────

export async function createThread(input: {
  userId: string;
  subjectType: QuestionSubjectType;
  subjectId: string;
  visibility: QuestionVisibility;
  body: string;
}): Promise<QuestionThreadDetail> {
  const subject = await resolveVisibleSubject(input.subjectType, input.subjectId);
  await assertThreadRateLimit(input.userId);

  const rel = await resolveViewerRelation(input.userId, subject.tenantId);
  const kind = resolveAuthorKind(rel);

  const thread = await db.transaction(async (tx) => {
    const [t] = await tx
      .insert(questionThreads)
      .values({
        tenantId: subject.tenantId,
        subjectType: input.subjectType,
        eventId: input.subjectType === 'event' ? input.subjectId : null,
        arenaId: input.subjectType === 'arena' ? input.subjectId : null,
        membershipId: input.subjectType === 'membership' ? input.subjectId : null,
        visibility: input.visibility,
        authorUserId: input.userId,
      })
      .returning();
    if (!t) throw new Error('question_thread_insert_failed');
    await tx.insert(questionMessages).values({
      threadId: t.id,
      authorUserId: input.userId,
      authorKind: kind,
      body: input.body,
    });
    return t;
  });

  // Best-effort org email — never blocks or fails the write.
  await onQuestionAsked(thread.id);

  return getThreadDetailForViewer(thread.id, {
    userId: input.userId,
    ...rel,
  });
}

// ── Listings ──────────────────────────────────────────────────────────────────

const SUBJECT_COL: Record<QuestionSubjectType, string> = {
  event: 'event_id',
  arena: 'arena_id',
  membership: 'membership_id',
};

interface RawThreadRow extends Record<string, unknown> {
  id: string;
}

function mapListRow(r: Record<string, unknown>, opts: { withSubject: boolean }): QuestionThreadListRow {
  const subjectType = r['subject_type'] as QuestionSubjectType;
  const subjectId = (r['event_id'] ?? r['arena_id'] ?? r['membership_id']) as string;
  const row: QuestionThreadListRow = {
    id: r['id'] as string,
    subjectType,
    subjectId,
    tenantId: r['tenant_id'] as string,
    visibility: r['visibility'] as QuestionVisibility,
    status: r['status'] as QuestionStatus,
    rootBody: excerpt((r['root_body'] as string | null) ?? ''),
    replyCount: Math.max(Number(r['message_count'] ?? 1) - 1, 0),
    authorName: authorName(
      r['root_author_kind'] as QuestionAuthorKind,
      (r['root_author_name'] as string | null) ?? null,
      (r['tenant_name'] as string | null) ?? 'Organizer',
    ),
    lastMessageAt: isoOf(r['last_message_at']),
    createdAt: isoOf(r['created_at']),
  };
  if (opts.withSubject) {
    row.subject = {
      type: subjectType,
      id: subjectId,
      name: (r['subject_name'] as string | null) ?? '',
    };
  }
  return row;
}

function pageOf(
  raw: Record<string, unknown>[],
  limit: number,
  opts: { withSubject: boolean },
): QuestionThreadListPage {
  const hasMore = raw.length > limit;
  const pageRows = hasMore ? raw.slice(0, limit) : raw;
  const rows = pageRows.map((r) => mapListRow(r, opts));
  let nextCursor: string | null = null;
  if (hasMore && rows.length > 0) {
    const last = rows[rows.length - 1]!;
    nextCursor = `${last.lastMessageAt}|${last.id}`;
  }
  return { rows, nextCursor };
}

/**
 * Public threads for a subject, newest-activity first. Threads whose root
 * message is hidden (admin moderation) are excluded entirely.
 */
export async function listPublicThreads(params: {
  subjectType: QuestionSubjectType;
  subjectId: string;
  cursor?: string | undefined;
  limit?: number | undefined;
}): Promise<QuestionThreadListPage> {
  const limit = clampLimit(params.limit);
  const cur = parseCursor(params.cursor);
  const col = SUBJECT_COL[params.subjectType];

  const res = await db.execute<RawThreadRow>(sql`
    select t.id, t.tenant_id, t.subject_type, t.event_id, t.arena_id, t.membership_id,
           t.visibility, t.status, t.last_message_at, t.message_count, t.created_at,
           root.body as root_body, root.author_kind as root_author_kind,
           u.display_name as root_author_name, tn.name as tenant_name
      from question_threads t
      join lateral (
        select qm.body, qm.hidden_at, qm.author_kind, qm.author_user_id
          from question_messages qm
         where qm.thread_id = t.id
         order by qm.created_at asc, qm.id asc
         limit 1
      ) root on true
      left join users u on u.id = root.author_user_id
      join tenants tn on tn.id = t.tenant_id
     where t.visibility = 'public'
       and ${sql.raw(`t."${col}"`)} = ${params.subjectId}::uuid
       and root.hidden_at is null
       ${cur ? sql`and (t.last_message_at, t.id) < (${cur.ts}::timestamptz, ${cur.id}::uuid)` : sql``}
     order by t.last_message_at desc, t.id desc
     limit ${limit + 1}
  `);
  return pageOf(rowsOf(res), limit, { withSubject: false });
}

/** The caller's own threads (both visibilities), optional subject filter. */
export async function listMyThreads(params: {
  userId: string;
  subjectType?: QuestionSubjectType | undefined;
  subjectId?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}): Promise<QuestionThreadListPage> {
  const limit = clampLimit(params.limit);
  const cur = parseCursor(params.cursor);
  const subjectFilter =
    params.subjectType && params.subjectId
      ? sql`and t.subject_type = ${params.subjectType} and ${sql.raw(`t."${SUBJECT_COL[params.subjectType]}"`)} = ${params.subjectId}::uuid`
      : sql``;

  const res = await db.execute<RawThreadRow>(sql`
    select t.id, t.tenant_id, t.subject_type, t.event_id, t.arena_id, t.membership_id,
           t.visibility, t.status, t.last_message_at, t.message_count, t.created_at,
           root.body as root_body, root.author_kind as root_author_kind,
           u.display_name as root_author_name, tn.name as tenant_name,
           coalesce(e.name, a.name, m.name) as subject_name
      from question_threads t
      join lateral (
        select qm.body, qm.author_kind, qm.author_user_id
          from question_messages qm
         where qm.thread_id = t.id
         order by qm.created_at asc, qm.id asc
         limit 1
      ) root on true
      left join users u on u.id = root.author_user_id
      join tenants tn on tn.id = t.tenant_id
      left join events e on e.id = t.event_id
      left join arenas a on a.id = t.arena_id
      left join memberships m on m.id = t.membership_id
     where t.author_user_id = ${params.userId}::uuid
       ${subjectFilter}
       ${cur ? sql`and (t.last_message_at, t.id) < (${cur.ts}::timestamptz, ${cur.id}::uuid)` : sql``}
     order by t.last_message_at desc, t.id desc
     limit ${limit + 1}
  `);
  return pageOf(rowsOf(res), limit, { withSubject: true });
}

/** Org inbox / admin listing. tenantId narrows to one org (partner surface). */
export async function listStaffThreads(params: {
  tenantId?: string | undefined;
  status?: QuestionStatus | undefined;
  visibility?: QuestionVisibility | undefined;
  subjectType?: QuestionSubjectType | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}): Promise<QuestionThreadListPage> {
  const limit = clampLimit(params.limit);
  const cur = parseCursor(params.cursor);

  const res = await db.execute<RawThreadRow>(sql`
    select t.id, t.tenant_id, t.subject_type, t.event_id, t.arena_id, t.membership_id,
           t.visibility, t.status, t.last_message_at, t.message_count, t.created_at,
           root.body as root_body, root.author_kind as root_author_kind,
           u.display_name as root_author_name, tn.name as tenant_name,
           coalesce(e.name, a.name, m.name) as subject_name
      from question_threads t
      join lateral (
        select qm.body, qm.author_kind, qm.author_user_id
          from question_messages qm
         where qm.thread_id = t.id
         order by qm.created_at asc, qm.id asc
         limit 1
      ) root on true
      left join users u on u.id = root.author_user_id
      join tenants tn on tn.id = t.tenant_id
      left join events e on e.id = t.event_id
      left join arenas a on a.id = t.arena_id
      left join memberships m on m.id = t.membership_id
     where true
       ${params.tenantId ? sql`and t.tenant_id = ${params.tenantId}::uuid` : sql``}
       ${params.status ? sql`and t.status = ${params.status}` : sql``}
       ${params.visibility ? sql`and t.visibility = ${params.visibility}` : sql``}
       ${params.subjectType ? sql`and t.subject_type = ${params.subjectType}` : sql``}
       ${cur ? sql`and (t.last_message_at, t.id) < (${cur.ts}::timestamptz, ${cur.id}::uuid)` : sql``}
     order by t.last_message_at desc, t.id desc
     limit ${limit + 1}
  `);
  return pageOf(rowsOf(res), limit, { withSubject: true });
}

/** `{ openCount }` for the partner sidebar badge. */
export async function countOpenThreads(tenantId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(questionThreads)
    .where(and(eq(questionThreads.tenantId, tenantId), eq(questionThreads.status, 'open')));
  return row?.n ?? 0;
}

// ── Thread detail ─────────────────────────────────────────────────────────────

export interface ThreadViewer extends ViewerRelation {
  userId: string | null;
}

/**
 * Tenant of a thread (404 `question_not_found` when missing). Used by the
 * consumer detail route to resolve the viewer's org/platform relationship
 * before the visibility-scoped read.
 */
export async function getThreadTenantId(threadId: string): Promise<string> {
  const [t] = await db
    .select({ tenantId: questionThreads.tenantId })
    .from(questionThreads)
    .where(eq(questionThreads.id, threadId))
    .limit(1);
  if (!t) threadNotFound();
  return t.tenantId;
}

async function loadThread(threadId: string): Promise<QuestionThread> {
  const [t] = await db
    .select()
    .from(questionThreads)
    .where(eq(questionThreads.id, threadId))
    .limit(1);
  if (!t) threadNotFound();
  return t;
}

async function loadTenantName(tenantId: string): Promise<string> {
  const [t] = await db
    .select({ name: tenants.name })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  return t?.name ?? 'Organizer';
}

async function loadMessages(
  threadId: string,
): Promise<{ m: QuestionMessage; displayName: string | null }[]> {
  const rows = await db
    .select({ m: questionMessages, displayName: users.displayName })
    .from(questionMessages)
    .leftJoin(users, eq(users.id, questionMessages.authorUserId))
    .where(eq(questionMessages.threadId, threadId))
    .orderBy(asc(questionMessages.createdAt), asc(questionMessages.id));
  return rows;
}

function serializeThread(t: QuestionThread): QuestionThreadDetail['thread'] {
  return {
    id: t.id,
    subjectType: t.subjectType,
    subjectId: subjectIdOf(t),
    tenantId: t.tenantId,
    visibility: t.visibility,
    status: t.status,
    authorUserId: t.authorUserId,
    messageCount: t.messageCount,
    lastMessageAt: t.lastMessageAt.toISOString(),
    createdAt: t.createdAt.toISOString(),
  };
}

function serializeMessage(
  m: QuestionMessage,
  displayName: string | null,
  tenantName: string,
): QuestionMessageRow {
  return {
    id: m.id,
    threadId: m.threadId,
    authorKind: m.authorKind,
    authorName: authorName(m.authorKind, displayName, tenantName),
    body: m.body,
    hiddenAt: m.hiddenAt ? m.hiddenAt.toISOString() : null,
    createdAt: m.createdAt.toISOString(),
  };
}

/**
 * Consumer-surface thread detail. Public threads: anyone (signed-out
 * included). Private threads: the author, org members, and Circls staff —
 * everyone else gets 404 `question_not_found` (no existence leak). Hidden
 * messages are omitted unless the viewer is the message's author, an org
 * member, or Circls staff.
 */
export async function getThreadDetailForViewer(
  threadId: string,
  viewer: ThreadViewer,
): Promise<QuestionThreadDetail> {
  const t = await loadThread(threadId);
  const isThreadAuthor = viewer.userId !== null && viewer.userId === t.authorUserId;
  const privileged = viewer.isOrgMember || viewer.isPlatformMember;
  if (t.visibility === 'private' && !isThreadAuthor && !privileged) threadNotFound();

  const tenantName = await loadTenantName(t.tenantId);
  const all = await loadMessages(threadId);
  const messages = all
    .filter(
      ({ m }) =>
        m.hiddenAt === null || privileged || (viewer.userId !== null && m.authorUserId === viewer.userId),
    )
    .map(({ m, displayName }) => serializeMessage(m, displayName, tenantName));

  return { thread: serializeThread(t), messages };
}

/** Partner/admin thread detail: hidden messages marked, never omitted. */
export async function getThreadDetailForStaff(
  threadId: string,
  opts: { tenantId?: string | undefined } = {},
): Promise<QuestionThreadDetail> {
  const t = await loadThread(threadId);
  if (opts.tenantId && t.tenantId !== opts.tenantId) threadNotFound();
  const tenantName = await loadTenantName(t.tenantId);
  const all = await loadMessages(threadId);
  return {
    thread: serializeThread(t),
    messages: all.map(({ m, displayName }) => serializeMessage(m, displayName, tenantName)),
  };
}

// ── Replies ───────────────────────────────────────────────────────────────────

interface AddMessageResult {
  message: QuestionMessageRow;
  threadStatus: QuestionStatus;
}

async function insertReply(
  t: QuestionThread,
  userId: string,
  kind: QuestionAuthorKind,
  body: string,
): Promise<AddMessageResult> {
  const isThreadAuthor = userId === t.authorUserId;
  const newStatus = nextStatusOnReply(t.status, kind, isThreadAuthor);

  const message = await db.transaction(async (tx) => {
    const [m] = await tx
      .insert(questionMessages)
      .values({ threadId: t.id, authorUserId: userId, authorKind: kind, body })
      .returning();
    if (!m) throw new Error('question_message_insert_failed');
    await tx
      .update(questionThreads)
      .set({
        lastMessageAt: m.createdAt,
        messageCount: sql`${questionThreads.messageCount} + 1`,
        status: newStatus,
      })
      .where(eq(questionThreads.id, t.id));
    return m;
  });

  // Org/Circls replies email the thread author (best-effort; no email when the
  // author replies to their own thread).
  if ((kind === 'org' || kind === 'circls') && !isThreadAuthor) {
    await onQuestionReplied(t.id, message.id);
  }

  const tenantName = await loadTenantName(t.tenantId);
  const [displayRow] = await db
    .select({ displayName: users.displayName })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return {
    message: serializeMessage(message, displayRow?.displayName ?? null, tenantName),
    threadStatus: newStatus,
  };
}

/**
 * Consumer-surface reply. Allowed: thread author (any visibility), any
 * signed-in user on public threads, org/circls members. Private threads 404
 * for everyone else; closed threads 409 `question_closed` for everyone.
 */
export async function addConsumerMessage(input: {
  threadId: string;
  userId: string;
  body: string;
}): Promise<AddMessageResult> {
  const t = await loadThread(input.threadId);
  const rel = await resolveViewerRelation(input.userId, t.tenantId);
  const isThreadAuthor = input.userId === t.authorUserId;
  if (t.visibility === 'private' && !isThreadAuthor && !rel.isOrgMember && !rel.isPlatformMember) {
    threadNotFound();
  }
  if (t.status === 'closed') {
    throw new Conflict('This question is closed', 'question_closed');
  }
  await assertMessageRateLimit(input.userId);
  return insertReply(t, input.userId, resolveAuthorKind(rel), input.body);
}

/** Partner-surface reply — always stamped `org`. Caller has questions.write. */
export async function addOrgMessage(input: {
  tenantId: string;
  threadId: string;
  userId: string;
  body: string;
}): Promise<AddMessageResult> {
  const t = await loadThread(input.threadId);
  if (t.tenantId !== input.tenantId) threadNotFound();
  if (t.status === 'closed') {
    throw new Conflict('This question is closed — reopen it first', 'question_closed');
  }
  return insertReply(t, input.userId, 'org', input.body);
}

/** Admin-surface reply — always stamped `circls`. */
export async function addCirclsMessage(input: {
  threadId: string;
  userId: string;
  body: string;
}): Promise<AddMessageResult> {
  const t = await loadThread(input.threadId);
  if (t.status === 'closed') {
    throw new Conflict('This question is closed — reopen it first', 'question_closed');
  }
  return insertReply(t, input.userId, 'circls', input.body);
}

// ── Status patches ────────────────────────────────────────────────────────────

/** Author-only status change (consumer surface): `answered` | `closed`. */
export async function setStatusAsAuthor(input: {
  threadId: string;
  userId: string;
  status: AuthorPatchStatus;
}): Promise<QuestionThreadDetail['thread']> {
  const t = await loadThread(input.threadId);
  if (t.authorUserId !== input.userId) threadNotFound();
  const next = applyAuthorStatusPatch(t.status, input.status);
  if (next === null) {
    throw new Conflict('This question is closed', 'question_closed');
  }
  return persistStatus(t.id, next);
}

/** Org/admin status change — any of the three (reopen included). */
export async function setStatusAsStaff(input: {
  threadId: string;
  status: QuestionStatus;
  tenantId?: string | undefined;
}): Promise<QuestionThreadDetail['thread']> {
  const t = await loadThread(input.threadId);
  if (input.tenantId && t.tenantId !== input.tenantId) threadNotFound();
  return persistStatus(t.id, input.status);
}

async function persistStatus(
  threadId: string,
  status: QuestionStatus,
): Promise<QuestionThreadDetail['thread']> {
  const [updated] = await db
    .update(questionThreads)
    .set({ status })
    .where(eq(questionThreads.id, threadId))
    .returning();
  if (!updated) threadNotFound();
  return serializeThread(updated);
}

// ── Moderation (hide / unhide) ────────────────────────────────────────────────

/**
 * Hide or unhide a message on a public thread. Org callers (`allowRoot:
 * false`) can never touch the root message; Circls admin (`allowRoot: true`)
 * can hide any message — hiding the root removes the thread from the public
 * list while staying visible (marked) to author/org/admin.
 */
export async function setMessageHidden(input: {
  threadId: string;
  messageId: string;
  byUserId: string;
  hidden: boolean;
  allowRoot: boolean;
  tenantId?: string | undefined;
}): Promise<QuestionMessageRow> {
  const t = await loadThread(input.threadId);
  if (input.tenantId && t.tenantId !== input.tenantId) threadNotFound();
  if (t.visibility !== 'public') {
    throw new BadRequest('Moderation applies to public threads only', 'not_public_thread');
  }

  const [msg] = await db
    .select()
    .from(questionMessages)
    .where(
      and(eq(questionMessages.id, input.messageId), eq(questionMessages.threadId, input.threadId)),
    )
    .limit(1);
  if (!msg) throw new NotFound('Message not found', 'question_message_not_found');

  if (!input.allowRoot) {
    const [root] = await db
      .select({ id: questionMessages.id })
      .from(questionMessages)
      .where(eq(questionMessages.threadId, input.threadId))
      .orderBy(asc(questionMessages.createdAt), asc(questionMessages.id))
      .limit(1);
    if (root && root.id === msg.id) {
      throw new BadRequest('The root message cannot be moderated by the org', 'cannot_hide_root');
    }
  }

  const [updated] = await db
    .update(questionMessages)
    .set(
      input.hidden
        ? { hiddenAt: new Date(), hiddenByUserId: input.byUserId }
        : { hiddenAt: null, hiddenByUserId: null },
    )
    .where(eq(questionMessages.id, msg.id))
    .returning();
  if (!updated) throw new NotFound('Message not found', 'question_message_not_found');

  const tenantName = await loadTenantName(t.tenantId);
  const [displayRow] = await db
    .select({ displayName: users.displayName })
    .from(users)
    .where(eq(users.id, updated.authorUserId))
    .limit(1);
  return serializeMessage(updated, displayRow?.displayName ?? null, tenantName);
}
