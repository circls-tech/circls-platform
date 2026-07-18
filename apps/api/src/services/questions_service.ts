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
import type { TenantRole } from '../db/schema/tenant_members.js';
import { tenants } from '../db/schema/tenants.js';
import { users } from '../db/schema/users.js';
import { can } from '../lib/authz/can.js';
import { BadRequest, Conflict, Forbidden, NotFound, RateLimit } from '../lib/errors.js';
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
  /** Staff (partner/admin) lists only: when the thread is archived. */
  archivedAt?: string | null;
  /** Staff lists only: who archived the thread. */
  archivedByKind?: QuestionHiddenByKind | null;
}

/** Who hid a message (moderation hierarchy: org can only undo its own hides). */
export type QuestionHiddenByKind = 'org' | 'circls';

export interface QuestionMessageRow {
  id: string;
  threadId: string;
  authorKind: QuestionAuthorKind;
  authorName: string;
  /** True when the message was posted by the requesting (bearer) user. */
  own: boolean;
  body: string;
  /** Set only when the message is hidden AND the viewer may see it marked. */
  hiddenAt: string | null;
  /** Staff (partner/admin) serializations only: who hid the message. */
  hiddenByKind?: QuestionHiddenByKind | null;
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
    /** Subject summary (joined name), same shape as staff list rows. */
    subject: QuestionSubjectSummary;
    /** Display name of the thread author (root-message author resolution). */
    authorName: string;
    /** Staff (partner/admin) serializations only — never on consumer payloads. */
    archivedAt?: string | null;
    /** Staff serializations only: who archived the thread ('org' | 'circls'). */
    archivedByKind?: QuestionHiddenByKind | null;
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

/**
 * Cursor = `${lastMessageAt}|${id}` (webhook deliveries convention). The
 * timestamp is emitted by Postgres itself (`last_message_at::text`, µs
 * precision) so it round-trips losslessly — `Date.toISOString()` truncates to
 * milliseconds while Postgres stores microseconds, which can skip rows at
 * page boundaries. Accepts both the Postgres text format and strict ISO.
 */
const CURSOR_TS_RE =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parse + validate a cursor. Malformed cursors are a 400, never a SQL 500. */
export function parseCursor(cursor: string | undefined): { ts: string; id: string } | null {
  if (!cursor) return null;
  const idx = cursor.lastIndexOf('|');
  const ts = idx > 0 ? cursor.slice(0, idx) : '';
  const id = idx > 0 ? cursor.slice(idx + 1) : '';
  if (!CURSOR_TS_RE.test(ts) || !UUID_RE.test(id)) {
    throw new BadRequest('Invalid cursor', 'bad_request');
  }
  return { ts, id };
}

/** Build the cursor for a raw list row (uses the µs-precision `cursor_ts`). */
export function encodeCursor(raw: Record<string, unknown>): string {
  return `${String(raw['cursor_ts'])}|${String(raw['id'])}`;
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
  /** Member of a platform tenant — read access (private threads, hidden msgs). */
  isPlatformMember: boolean;
  /** Member of the thread's tenant (any role) — read access, partner-surface parity. */
  isOrgMember: boolean;
  /** Holds `questions.write` on the thread's tenant → posts stamped `org`. */
  canPostAsOrg: boolean;
  /** Holds `admin.support.write` on the platform tenant → posts stamped `circls`. */
  canPostAsCircls: boolean;
}

/** The relation of a signed-out (or unrelated) viewer. */
export const ANONYMOUS_RELATION: ViewerRelation = {
  isPlatformMember: false,
  isOrgMember: false,
  canPostAsOrg: false,
  canPostAsCircls: false,
};

/**
 * A single query answering the membership + capability questions behind
 * author_kind stamping and hidden-message visibility. Bare membership grants
 * *read* parity with the staff surfaces, but posting *as* the org / Circls
 * requires the corresponding write capability (`can()` on the member's role) —
 * a `readonly` member must never be stamped `org`/`circls`. Checks
 * `is_platform` directly (not the cached platform-tenant id) so it degrades
 * safely when the platform tenant isn't bootstrapped.
 */
export async function resolveViewerRelation(
  userId: string,
  tenantId: string,
): Promise<ViewerRelation> {
  const res = await db.execute<Record<string, unknown>>(sql`
    select tm.tenant_id::text as tenant_id, tm.role as role, t.is_platform as is_platform
      from tenant_members tm
      join tenants t on t.id = tm.tenant_id
     where tm.user_id = ${userId}::uuid
  `);
  const rel: ViewerRelation = { ...ANONYMOUS_RELATION };
  for (const r of rowsOf(res)) {
    const role = r['role'] as TenantRole;
    const isPlatform = Boolean(r['is_platform']);
    if (r['tenant_id'] === tenantId) {
      rel.isOrgMember = true;
      if (can({ role, isPlatform }, 'questions.write')) rel.canPostAsOrg = true;
    }
    if (isPlatform) {
      rel.isPlatformMember = true;
      if (can({ role, isPlatform: true }, 'admin.support.write')) rel.canPostAsCircls = true;
    }
  }
  return rel;
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

function mapListRow(
  r: Record<string, unknown>,
  opts: { withSubject: boolean; staff?: boolean },
): QuestionThreadListRow {
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
    // Public rows carry `visible_count` (non-hidden messages) so anonymous
    // viewers' counts match what they can actually see; staff rows use totals.
    replyCount: Math.max(Number(r['visible_count'] ?? r['message_count'] ?? 1) - 1, 0),
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
  // Archive state is a staff-only detail — never on consumer list rows.
  if (opts.staff) {
    row.archivedAt = r['archived_at'] == null ? null : isoOf(r['archived_at']);
    row.archivedByKind = (r['archived_by_kind'] as QuestionHiddenByKind | null) ?? null;
  }
  return row;
}

function pageOf(
  raw: Record<string, unknown>[],
  limit: number,
  opts: { withSubject: boolean; staff?: boolean },
): QuestionThreadListPage {
  const hasMore = raw.length > limit;
  const pageRows = hasMore ? raw.slice(0, limit) : raw;
  const rows = pageRows.map((r) => mapListRow(r, opts));
  let nextCursor: string | null = null;
  if (hasMore && pageRows.length > 0) {
    // Cursor from the raw row's µs-precision `cursor_ts`, not the ms-truncated
    // ISO string — sub-ms neighbours must not be skipped at the boundary.
    nextCursor = encodeCursor(pageRows[pageRows.length - 1]!);
  }
  return { rows, nextCursor };
}

/**
 * Public threads for a subject, newest-activity first. Threads whose root
 * message is hidden (admin moderation) — and archived threads — are excluded
 * entirely.
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
           t.last_message_at::text as cursor_ts,
           (select count(*)::int from question_messages qmv
             where qmv.thread_id = t.id and qmv.hidden_at is null) as visible_count,
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
       and t.archived_at is null
       and root.hidden_at is null
       ${cur ? sql`and (t.last_message_at, t.id) < (${cur.ts}::timestamptz, ${cur.id}::uuid)` : sql``}
     order by t.last_message_at desc, t.id desc
     limit ${limit + 1}
  `);
  return pageOf(rowsOf(res), limit, { withSubject: false });
}

/**
 * The caller's own threads (both visibilities), optional subject filter.
 * Archived threads are excluded — consumer surfaces treat them as nonexistent,
 * for the thread author too.
 */
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
           t.last_message_at::text as cursor_ts,
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
       and t.archived_at is null
       ${subjectFilter}
       ${cur ? sql`and (t.last_message_at, t.id) < (${cur.ts}::timestamptz, ${cur.id}::uuid)` : sql``}
     order by t.last_message_at desc, t.id desc
     limit ${limit + 1}
  `);
  return pageOf(rowsOf(res), limit, { withSubject: true });
}

/**
 * Org inbox / admin listing. tenantId narrows to one org (partner surface).
 * `archived` selects the archived view (default: only non-archived threads —
 * archived ones live behind an explicit archived=true filter).
 */
export async function listStaffThreads(params: {
  tenantId?: string | undefined;
  status?: QuestionStatus | undefined;
  visibility?: QuestionVisibility | undefined;
  subjectType?: QuestionSubjectType | undefined;
  archived?: boolean | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}): Promise<QuestionThreadListPage> {
  const limit = clampLimit(params.limit);
  const cur = parseCursor(params.cursor);

  const res = await db.execute<RawThreadRow>(sql`
    select t.id, t.tenant_id, t.subject_type, t.event_id, t.arena_id, t.membership_id,
           t.visibility, t.status, t.last_message_at, t.message_count, t.created_at,
           t.archived_at, t.archived_by_kind,
           t.last_message_at::text as cursor_ts,
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
     where ${params.archived ? sql`t.archived_at is not null` : sql`t.archived_at is null`}
       ${params.tenantId ? sql`and t.tenant_id = ${params.tenantId}::uuid` : sql``}
       ${params.status ? sql`and t.status = ${params.status}` : sql``}
       ${params.visibility ? sql`and t.visibility = ${params.visibility}` : sql``}
       ${params.subjectType ? sql`and t.subject_type = ${params.subjectType}` : sql``}
       ${cur ? sql`and (t.last_message_at, t.id) < (${cur.ts}::timestamptz, ${cur.id}::uuid)` : sql``}
     order by t.last_message_at desc, t.id desc
     limit ${limit + 1}
  `);
  return pageOf(rowsOf(res), limit, { withSubject: true, staff: true });
}

/** `{ openCount }` for the partner sidebar badge. Archived threads don't count. */
export async function countOpenThreads(tenantId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(questionThreads)
    .where(
      and(
        eq(questionThreads.tenantId, tenantId),
        eq(questionThreads.status, 'open'),
        sql`${questionThreads.archivedAt} is null`,
      ),
    );
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

/** Joined context for a thread's DETAIL serialization (subject + root author). */
interface ThreadExtras {
  subjectName: string;
  tenantName: string;
  rootAuthorKind: QuestionAuthorKind;
  rootDisplayName: string | null;
  /** True when the root message is hidden (admin moderation). */
  rootHidden: boolean;
}

async function loadThreadExtras(threadId: string): Promise<ThreadExtras> {
  const res = await db.execute<Record<string, unknown>>(sql`
    select coalesce(e.name, a.name, m.name) as subject_name,
           tn.name as tenant_name,
           root.author_kind as root_author_kind,
           (root.hidden_at is not null) as root_hidden,
           u.display_name as root_author_name
      from question_threads t
      join tenants tn on tn.id = t.tenant_id
      left join events e on e.id = t.event_id
      left join arenas a on a.id = t.arena_id
      left join memberships m on m.id = t.membership_id
      join lateral (
        select qm.author_kind, qm.author_user_id, qm.hidden_at
          from question_messages qm
         where qm.thread_id = t.id
         order by qm.created_at asc, qm.id asc
         limit 1
      ) root on true
      left join users u on u.id = root.author_user_id
     where t.id = ${threadId}::uuid
     limit 1
  `);
  const r = rowsOf(res)[0];
  if (!r) threadNotFound();
  return {
    subjectName: (r['subject_name'] as string | null) ?? '',
    tenantName: (r['tenant_name'] as string | null) ?? 'Organizer',
    rootAuthorKind: r['root_author_kind'] as QuestionAuthorKind,
    rootDisplayName: (r['root_author_name'] as string | null) ?? null,
    rootHidden: Boolean(r['root_hidden']),
  };
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

function serializeThread(
  t: QuestionThread,
  extras: ThreadExtras,
  opts: { staff?: boolean } = {},
): QuestionThreadDetail['thread'] {
  const subjectId = subjectIdOf(t);
  const thread: QuestionThreadDetail['thread'] = {
    id: t.id,
    subjectType: t.subjectType,
    subjectId,
    tenantId: t.tenantId,
    visibility: t.visibility,
    status: t.status,
    authorUserId: t.authorUserId,
    messageCount: t.messageCount,
    lastMessageAt: t.lastMessageAt.toISOString(),
    createdAt: t.createdAt.toISOString(),
    subject: { type: t.subjectType, id: subjectId, name: extras.subjectName },
    authorName: authorName(extras.rootAuthorKind, extras.rootDisplayName, extras.tenantName),
  };
  // Archive state is staff-only — consumer payloads never carry it (org/circls
  // viewers on the consumer surface use their staff surfaces for that).
  if (opts.staff) {
    thread.archivedAt = t.archivedAt ? t.archivedAt.toISOString() : null;
    thread.archivedByKind = t.archivedByKind ?? null;
  }
  return thread;
}

function serializeMessage(
  m: QuestionMessage,
  displayName: string | null,
  tenantName: string,
  opts: { viewerUserId: string | null; staff?: boolean },
): QuestionMessageRow {
  const row: QuestionMessageRow = {
    id: m.id,
    threadId: m.threadId,
    authorKind: m.authorKind,
    authorName: authorName(m.authorKind, displayName, tenantName),
    own: opts.viewerUserId !== null && m.authorUserId === opts.viewerUserId,
    body: m.body,
    hiddenAt: m.hiddenAt ? m.hiddenAt.toISOString() : null,
    createdAt: m.createdAt.toISOString(),
  };
  // Only staff surfaces learn who hid a message; consumer payloads never
  // expose moderation attribution (nor any replier user ids).
  if (opts.staff) row.hiddenByKind = m.hiddenByKind ?? null;
  return row;
}

/**
 * Consumer-surface thread detail. Public threads: anyone (signed-out
 * included). Private threads: the author, org members, and Circls staff —
 * everyone else gets 404 `question_not_found` (no existence leak). Hidden
 * messages are omitted unless the viewer is the message's author, an org
 * member, or Circls staff. Archived threads are nonexistent (404) for every
 * consumer-surface viewer INCLUDING the thread author — only org/platform
 * members retain access here, consistent with their staff surfaces.
 */
export async function getThreadDetailForViewer(
  threadId: string,
  viewer: ThreadViewer,
): Promise<QuestionThreadDetail> {
  const t = await loadThread(threadId);
  const isThreadAuthor = viewer.userId !== null && viewer.userId === t.authorUserId;
  const privileged = viewer.isOrgMember || viewer.isPlatformMember;
  if (t.archivedAt !== null && !privileged) threadNotFound();
  if (t.visibility === 'private' && !isThreadAuthor && !privileged) threadNotFound();

  const extras = await loadThreadExtras(threadId);
  // Root-hidden threads are delisted from the public feed; outsiders get a
  // 404 on the detail too (the author and staff-adjacent viewers still see it).
  if (extras.rootHidden && !isThreadAuthor && !privileged) threadNotFound();

  const all = await loadMessages(threadId);
  const messages = all
    .filter(
      ({ m }) =>
        m.hiddenAt === null || privileged || (viewer.userId !== null && m.authorUserId === viewer.userId),
    )
    .map(({ m, displayName }) =>
      serializeMessage(m, displayName, extras.tenantName, { viewerUserId: viewer.userId }),
    );

  return { thread: serializeThread(t, extras), messages };
}

/** Partner/admin thread detail: hidden messages marked, never omitted. */
export async function getThreadDetailForStaff(
  threadId: string,
  opts: { tenantId?: string | undefined; viewerUserId?: string | undefined } = {},
): Promise<QuestionThreadDetail> {
  const t = await loadThread(threadId);
  if (opts.tenantId && t.tenantId !== opts.tenantId) threadNotFound();
  const extras = await loadThreadExtras(threadId);
  const all = await loadMessages(threadId);
  return {
    thread: serializeThread(t, extras, { staff: true }),
    messages: all.map(({ m, displayName }) =>
      serializeMessage(m, displayName, extras.tenantName, {
        viewerUserId: opts.viewerUserId ?? null,
        staff: true,
      }),
    ),
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
  opts: { staff: boolean },
): Promise<AddMessageResult> {
  const isThreadAuthor = userId === t.authorUserId;

  const { message, newStatus } = await db.transaction(async (tx) => {
    // Re-read under lock: the callers' closed pre-check is a fast path that
    // races with a concurrent close/reply between the check and this write.
    // The transition is computed from the locked row, never the stale one.
    const [locked] = await tx
      .select()
      .from(questionThreads)
      .where(eq(questionThreads.id, t.id))
      .limit(1)
      .for('update');
    if (!locked) threadNotFound();
    if (locked.archivedAt !== null) {
      throw new Conflict('This question is archived — unarchive it first', 'question_archived');
    }
    if (locked.status === 'closed') {
      throw new Conflict('This question is closed', 'question_closed');
    }
    const next = nextStatusOnReply(locked.status, kind, isThreadAuthor);
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
        status: next,
      })
      .where(eq(questionThreads.id, t.id));
    return { message: m, newStatus: next };
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
    message: serializeMessage(message, displayRow?.displayName ?? null, tenantName, {
      viewerUserId: userId,
      staff: opts.staff,
    }),
    threadStatus: newStatus,
  };
}

/** True when the thread's root (earliest) message is hidden by moderation. */
async function isRootHidden(threadId: string): Promise<boolean> {
  const res = await db.execute<Record<string, unknown>>(sql`
    select (qm.hidden_at is not null) as root_hidden
      from question_messages qm
     where qm.thread_id = ${threadId}::uuid
     order by qm.created_at asc, qm.id asc
     limit 1
  `);
  return Boolean(rowsOf(res)[0]?.['root_hidden']);
}

/**
 * Consumer-surface reply. Allowed: thread author (any visibility), any
 * signed-in user on public threads, and cap-holding org/circls staff. Members
 * whose role lacks the write capability (e.g. `readonly`) post as plain
 * consumers — so on a private thread they aren't the author of, they 404 like
 * any outsider (they may still *read* it). Closed threads 409
 * `question_closed` for everyone; root-hidden public threads 404 for
 * outsiders (they can't see the thread, so they can't reply on it either).
 * Archived threads: 404 for consumer-surface viewers (author included) — the
 * thread is nonexistent to them; org/platform members get the staff-style 409
 * `question_archived` instead, since they can still see the thread.
 */
export async function addConsumerMessage(input: {
  threadId: string;
  userId: string;
  body: string;
}): Promise<AddMessageResult> {
  const t = await loadThread(input.threadId);
  const rel = await resolveViewerRelation(input.userId, t.tenantId);
  const isThreadAuthor = input.userId === t.authorUserId;
  const kind = resolveAuthorKind(rel);
  if (t.archivedAt !== null) {
    if (!rel.isOrgMember && !rel.isPlatformMember) threadNotFound();
    throw new Conflict('This question is archived — unarchive it first', 'question_archived');
  }
  if (t.visibility === 'private' && !isThreadAuthor && kind === 'consumer') {
    threadNotFound();
  }
  if (t.status === 'closed') {
    throw new Conflict('This question is closed', 'question_closed');
  }
  if (
    t.visibility === 'public' &&
    !isThreadAuthor &&
    !rel.isOrgMember &&
    !rel.isPlatformMember &&
    (await isRootHidden(t.id))
  ) {
    threadNotFound();
  }
  await assertMessageRateLimit(input.userId);
  return insertReply(t, input.userId, kind, input.body, { staff: false });
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
  if (t.archivedAt !== null) {
    throw new Conflict('This question is archived — unarchive it first', 'question_archived');
  }
  if (t.status === 'closed') {
    throw new Conflict('This question is closed — reopen it first', 'question_closed');
  }
  return insertReply(t, input.userId, 'org', input.body, { staff: true });
}

/** Admin-surface reply — always stamped `circls`. */
export async function addCirclsMessage(input: {
  threadId: string;
  userId: string;
  body: string;
}): Promise<AddMessageResult> {
  const t = await loadThread(input.threadId);
  if (t.archivedAt !== null) {
    throw new Conflict('This question is archived — unarchive it first', 'question_archived');
  }
  if (t.status === 'closed') {
    throw new Conflict('This question is closed — reopen it first', 'question_closed');
  }
  return insertReply(t, input.userId, 'circls', input.body, { staff: true });
}

// ── Status patches ────────────────────────────────────────────────────────────

/**
 * Author-only status change (consumer surface): `answered` | `closed`.
 * Archived threads 404 — nonexistent on the consumer surface, author included.
 */
export async function setStatusAsAuthor(input: {
  threadId: string;
  userId: string;
  status: AuthorPatchStatus;
}): Promise<QuestionThreadDetail['thread']> {
  const t = await loadThread(input.threadId);
  if (t.authorUserId !== input.userId) threadNotFound();
  if (t.archivedAt !== null) threadNotFound();
  // Fast-path pre-check; the authoritative check re-runs on the locked row.
  if (applyAuthorStatusPatch(t.status, input.status) === null) {
    throw new Conflict('This question is closed', 'question_closed');
  }
  return persistStatus(t.id, (locked) => {
    if (locked.archivedAt !== null) threadNotFound();
    const next = applyAuthorStatusPatch(locked.status, input.status);
    if (next === null) {
      throw new Conflict('This question is closed', 'question_closed');
    }
    return next;
  });
}

/**
 * Org/admin status change — any of the three (reopen included). Archived
 * threads reject status changes (409 question_archived) — unarchive first.
 */
export async function setStatusAsStaff(input: {
  threadId: string;
  status: QuestionStatus;
  tenantId?: string | undefined;
}): Promise<QuestionThreadDetail['thread']> {
  const t = await loadThread(input.threadId);
  if (input.tenantId && t.tenantId !== input.tenantId) threadNotFound();
  if (t.archivedAt !== null) {
    throw new Conflict('This question is archived — unarchive it first', 'question_archived');
  }
  return persistStatus(
    t.id,
    (locked) => {
      if (locked.archivedAt !== null) {
        throw new Conflict('This question is archived — unarchive it first', 'question_archived');
      }
      return input.status;
    },
    { staff: true },
  );
}

/**
 * Persist a status change computed from the row as it is at write time: the
 * row is re-read FOR UPDATE inside the transaction so a concurrent
 * close/reply can't slip between the caller's pre-check and the write.
 */
async function persistStatus(
  threadId: string,
  compute: (locked: QuestionThread) => QuestionStatus,
  opts: { staff?: boolean } = {},
): Promise<QuestionThreadDetail['thread']> {
  const updated = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(questionThreads)
      .where(eq(questionThreads.id, threadId))
      .limit(1)
      .for('update');
    if (!locked) threadNotFound();
    const [row] = await tx
      .update(questionThreads)
      .set({ status: compute(locked) })
      .where(eq(questionThreads.id, threadId))
      .returning();
    if (!row) threadNotFound();
    return row;
  });
  return serializeThread(updated, await loadThreadExtras(threadId), opts);
}

// ── Moderation (hide / unhide) ────────────────────────────────────────────────

/**
 * Hide or unhide a message on a public thread. Org callers (`allowRoot:
 * false`, `byKind: 'org'`) can never touch the root message; Circls admin
 * (`allowRoot: true`, `byKind: 'circls'`) can hide any message — hiding the
 * root removes the thread from the public list while staying visible (marked)
 * to author/org/admin. Moderation hierarchy: the org can only undo its own
 * hides — a message hidden by Circls stays hidden until Circls unhides it.
 */
export async function setMessageHidden(input: {
  threadId: string;
  messageId: string;
  byUserId: string;
  byKind: QuestionHiddenByKind;
  hidden: boolean;
  allowRoot: boolean;
  tenantId?: string | undefined;
}): Promise<QuestionMessageRow> {
  const t = await loadThread(input.threadId);
  if (input.tenantId && t.tenantId !== input.tenantId) threadNotFound();
  if (t.archivedAt !== null) {
    throw new Conflict('This question is archived — unarchive it first', 'question_archived');
  }
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

  const tenantName = await loadTenantName(t.tenantId);
  const serialize = async (m: QuestionMessage): Promise<QuestionMessageRow> => {
    const [displayRow] = await db
      .select({ displayName: users.displayName })
      .from(users)
      .where(eq(users.id, m.authorUserId))
      .limit(1);
    return serializeMessage(m, displayRow?.displayName ?? null, tenantName, {
      viewerUserId: input.byUserId,
      staff: true,
    });
  };

  if (input.hidden) {
    // Idempotent no-op on an already-hidden message: never overwrite the
    // original moderator's stamp (an org re-hide must not launder a Circls
    // hide into an org-unhidable one).
    if (msg.hiddenAt !== null) return serialize(msg);
  } else {
    if (input.byKind === 'org' && msg.hiddenAt !== null && msg.hiddenByKind === 'circls') {
      throw new Forbidden(
        'This message was hidden by the Circls team and can only be unhidden by Circls',
        'forbidden_moderation',
      );
    }
  }

  const [updated] = await db
    .update(questionMessages)
    .set(
      input.hidden
        ? { hiddenAt: new Date(), hiddenByUserId: input.byUserId, hiddenByKind: input.byKind }
        : { hiddenAt: null, hiddenByUserId: null, hiddenByKind: null },
    )
    .where(eq(questionMessages.id, msg.id))
    .returning();
  if (!updated) throw new NotFound('Message not found', 'question_message_not_found');

  return serialize(updated);
}

// ── Archiving (thread-level moderation) ───────────────────────────────────────

/**
 * Archive or unarchive a whole thread (any visibility). An archived thread
 * disappears from every consumer surface — public list, /mine, detail, replies
 * and author PATCH all behave as if the thread doesn't exist, thread author
 * included — while staff (org + Circls) keep full read access. Staff
 * replies/status/hide are rejected with 409 `question_archived` until the
 * thread is unarchived. Silent moderation action: no notifications/emails.
 *
 * Hierarchy mirrors hide/unhide: archiving an already-archived thread is an
 * idempotent no-op that never overwrites the original `archived_by_kind` (an
 * org re-archive must not launder a Circls archive into an org-undoable one);
 * the org can only unarchive its own archives, Circls can unarchive anything.
 */
export async function setThreadArchived(input: {
  threadId: string;
  byUserId: string;
  byKind: QuestionHiddenByKind;
  archived: boolean;
  tenantId?: string | undefined;
}): Promise<QuestionThreadDetail['thread']> {
  const t = await loadThread(input.threadId);
  if (input.tenantId && t.tenantId !== input.tenantId) threadNotFound();

  const serializeCurrent = async (): Promise<QuestionThreadDetail['thread']> => {
    const current = await loadThread(input.threadId);
    return serializeThread(current, await loadThreadExtras(input.threadId), { staff: true });
  };

  if (input.archived) {
    // Idempotent no-op on an already-archived thread — preserve the original
    // moderator's stamp. The `archived_at is null` guard makes this race-safe:
    // two concurrent archives can't overwrite each other's kind.
    if (t.archivedAt !== null) return serializeCurrent();
    const [updated] = await db
      .update(questionThreads)
      .set({
        archivedAt: new Date(),
        archivedByUserId: input.byUserId,
        archivedByKind: input.byKind,
      })
      .where(and(eq(questionThreads.id, t.id), sql`${questionThreads.archivedAt} is null`))
      .returning();
    if (!updated) return serializeCurrent(); // lost the race — already archived
    return serializeThread(updated, await loadThreadExtras(input.threadId), { staff: true });
  }

  // Unarchive. Already-unarchived → idempotent no-op.
  if (t.archivedAt === null) return serializeCurrent();
  if (input.byKind === 'org' && t.archivedByKind === 'circls') {
    throw new Forbidden(
      'This thread was archived by the Circls team and can only be unarchived by Circls',
      'forbidden_moderation',
    );
  }
  const [updated] = await db
    .update(questionThreads)
    .set({ archivedAt: null, archivedByUserId: null, archivedByKind: null })
    .where(
      and(
        eq(questionThreads.id, t.id),
        // Race guard: an org unarchive must never undo a concurrent Circls
        // archive that landed after our read.
        input.byKind === 'org'
          ? sql`${questionThreads.archivedByKind} = 'org'`
          : sql`${questionThreads.archivedAt} is not null`,
      ),
    )
    .returning();
  if (!updated) return serializeCurrent();
  return serializeThread(updated, await loadThreadExtras(input.threadId), { staff: true });
}
