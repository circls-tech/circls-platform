/**
 * Resolver context for question threads (design doc: docs/superpowers/specs/
 * 2026-07-18-support-context-threads-design.md §3). Staff (partner + admin)
 * thread detail pages show a context panel about the asker: who they are,
 * the booking pinned by the support intake, their relationship with the
 * tenant (bookings / memberships / prior threads), and — admin only — recent
 * consumer activity and historical support_issues.
 *
 * Scoping rules:
 *  - Partner surface: everything is tenant-scoped to the thread's tenant, and
 *    contact details (email/phone) appear only on PRIVATE threads — public
 *    askers haven't opted into sharing contact info.
 *  - Admin surface: cross-tenant everything, contact details always.
 */
import { eq, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  questionThreads,
  type QuestionCategory,
  type QuestionOrigin,
  type QuestionStatus,
  type QuestionSubjectType,
  type QuestionVisibility,
} from '../db/schema/question_threads.js';
import { users } from '../db/schema/users.js';
import { NotFound } from '../lib/errors.js';
import type { QuestionSubjectSummary } from './questions_service.js';

const BOOKINGS_LIMIT = 10;
const MEMBERSHIPS_LIMIT = 10;
const PRIOR_THREADS_LIMIT = 10;
const ACTIVITY_LIMIT = 20;
const SUPPORT_ISSUES_LIMIT = 10;
const EXCERPT_LEN = 280;

// ── Shapes ────────────────────────────────────────────────────────────────────

export interface ContextMember {
  id: string;
  displayName: string;
  /** users.created_at — when this person joined Circls. */
  memberSince: string;
  /** Present only when the viewer may see contact details (see module doc). */
  email?: string | null;
  phone?: string | null;
}

/** One booking row — used for both the pinned booking and the recent list. */
export interface ContextBooking {
  id: string;
  itemType: string;
  /** Human label: arena / event / membership name (venue name as fallback). */
  label: string;
  status: string;
  totalPaise: number | null;
  currency: string;
  paymentMethod: string;
  timeRange: { start: string; end: string } | null;
  createdAt: string;
}

export interface ContextMembership {
  id: string;
  membershipId: string;
  name: string;
  status: string;
  startsAt: string;
  endsAt: string;
}

export interface ContextPriorThread {
  id: string;
  status: QuestionStatus;
  visibility: QuestionVisibility;
  origin: QuestionOrigin;
  category: QuestionCategory | null;
  subject: QuestionSubjectSummary;
  lastMessageAt: string;
}

export interface ContextActivityRow {
  id: string;
  eventType: string;
  itemType: string | null;
  itemId: string | null;
  props: Record<string, unknown> | null;
  createdAt: string;
}

export interface ContextSupportIssue {
  id: string;
  source: string;
  category: string | null;
  status: string;
  /** First 280 chars of the free-text message. */
  messageExcerpt: string;
  createdAt: string;
}

export interface QuestionThreadContext {
  member: ContextMember;
  /** The booking pinned by the support intake; null when none. */
  contextBooking: ContextBooking | null;
  recentBookings: ContextBooking[];
  memberships: ContextMembership[];
  priorThreads: ContextPriorThread[];
  /** Admin surface only. */
  recentActivity?: ContextActivityRow[];
  /** Admin surface only. */
  supportIssues?: ContextSupportIssue[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function rowsOf(res: unknown): Record<string, unknown>[] {
  return res as unknown as Record<string, unknown>[];
}

function isoOf(v: unknown): string {
  return v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
}

function mapBookingRow(r: Record<string, unknown>): ContextBooking {
  const start = r['start_at'];
  const end = r['end_at'];
  return {
    id: r['id'] as string,
    itemType: r['item_type'] as string,
    label: (r['label'] as string | null) ?? 'Booking',
    status: r['status'] as string,
    totalPaise: r['total_paise'] == null ? null : Number(r['total_paise']),
    currency: r['currency'] as string,
    paymentMethod: r['payment_method'] as string,
    timeRange: start != null && end != null ? { start: isoOf(start), end: isoOf(end) } : null,
    createdAt: isoOf(r['created_at']),
  };
}

/** Shared booking SELECT: joins the item's name into a display label. */
function bookingSelect(where: SQL): SQL {
  return sql`
    select b.id, b.item_type, b.status, b.total_paise, b.currency, b.payment_method,
           b.created_at,
           lower(b.time_range) as start_at, upper(b.time_range) as end_at,
           coalesce(a.name, e.name, mm.name, v.name) as label
      from bookings b
      left join arenas a on a.id = b.slot_arena_id
      left join events e on e.id = nullif(b.item_data->>'eventId', '')::uuid
      left join memberships mm on mm.id = nullif(b.item_data->>'membershipId', '')::uuid
      left join venues v on v.id = b.venue_id
     ${where}
  `;
}

// ── Context assembly ──────────────────────────────────────────────────────────

/**
 * Build the resolver-context panel for a thread. `tenantId` (partner surface)
 * scopes every list to that tenant and 404s when the thread belongs to a
 * different one; `admin: true` unlocks cross-tenant lists + activity/issues
 * extras and always includes contact details.
 */
export async function getThreadContext(
  threadId: string,
  opts: { tenantId?: string | undefined; admin?: boolean },
): Promise<QuestionThreadContext> {
  const [t] = await db
    .select({
      id: questionThreads.id,
      tenantId: questionThreads.tenantId,
      visibility: questionThreads.visibility,
      authorUserId: questionThreads.authorUserId,
      contextBookingId: questionThreads.contextBookingId,
    })
    .from(questionThreads)
    .where(eq(questionThreads.id, threadId))
    .limit(1);
  if (!t || (opts.tenantId && t.tenantId !== opts.tenantId)) {
    throw new NotFound('Question not found', 'question_not_found');
  }

  const admin = opts.admin === true;
  const userId = t.authorUserId;
  // Contact details: private-thread askers have opted into a direct support
  // conversation; public askers haven't. Circls staff always see them.
  const withContact = admin || t.visibility === 'private';
  const tenantScope = admin ? null : t.tenantId;

  const [u] = await db
    .select({
      id: users.id,
      displayName: users.displayName,
      email: users.email,
      phoneE164: users.phoneE164,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!u) throw new NotFound('Question not found', 'question_not_found');

  const member: ContextMember = {
    id: u.id,
    displayName: u.displayName ?? 'Member',
    memberSince: u.createdAt.toISOString(),
  };
  if (withContact) {
    member.email = u.email ?? null;
    member.phone = u.phoneE164 ?? null;
  }

  // Pinned booking. The thread's tenant IS the booking's tenant by
  // construction of the support intake, but the partner surface re-checks it
  // anyway (defense in depth): a mismatched pin renders as "no booking"
  // rather than leaking another org's booking. Admin stays unscoped.
  let contextBooking: ContextBooking | null = null;
  if (t.contextBookingId) {
    const res = await db.execute<Record<string, unknown>>(
      bookingSelect(sql`
        where b.id = ${t.contextBookingId}::uuid
          ${tenantScope ? sql`and b.tenant_id = ${tenantScope}::uuid` : sql``}
        limit 1`),
    );
    const r = rowsOf(res)[0];
    contextBooking = r ? mapBookingRow(r) : null;
  }

  const recentRes = await db.execute<Record<string, unknown>>(
    bookingSelect(sql`
      where (b.customer_user_id = ${userId}::uuid or b.created_by_user_id = ${userId}::uuid)
        ${tenantScope ? sql`and b.tenant_id = ${tenantScope}::uuid` : sql``}
      order by b.created_at desc
      limit ${BOOKINGS_LIMIT}
    `),
  );
  const recentBookings = rowsOf(recentRes).map(mapBookingRow);

  const memRes = await db.execute<Record<string, unknown>>(sql`
    select um.id, um.membership_id, m.name, um.status, um.starts_at, um.ends_at
      from user_memberships um
      join memberships m on m.id = um.membership_id
     where um.user_id = ${userId}::uuid
       ${tenantScope ? sql`and m.tenant_id = ${tenantScope}::uuid` : sql``}
     order by (um.status = 'active') desc, um.ends_at desc
     limit ${MEMBERSHIPS_LIMIT}
  `);
  const membershipRows: ContextMembership[] = rowsOf(memRes).map((r) => ({
    id: r['id'] as string,
    membershipId: r['membership_id'] as string,
    name: r['name'] as string,
    status: r['status'] as string,
    startsAt: isoOf(r['starts_at']),
    endsAt: isoOf(r['ends_at']),
  }));

  const priorRes = await db.execute<Record<string, unknown>>(sql`
    select pt.id, pt.status, pt.visibility, pt.origin, pt.category, pt.subject_type,
           pt.event_id, pt.arena_id, pt.membership_id, pt.last_message_at,
           coalesce(e.name, a.name, m.name) as subject_name
      from question_threads pt
      left join events e on e.id = pt.event_id
      left join arenas a on a.id = pt.arena_id
      left join memberships m on m.id = pt.membership_id
     where pt.author_user_id = ${userId}::uuid
       and pt.id != ${threadId}::uuid
       ${tenantScope ? sql`and pt.tenant_id = ${tenantScope}::uuid` : sql``}
     order by pt.last_message_at desc, pt.id desc
     limit ${PRIOR_THREADS_LIMIT}
  `);
  const priorThreads: ContextPriorThread[] = rowsOf(priorRes).map((r) => {
    const subjectType = r['subject_type'] as QuestionSubjectType;
    const subjectId = (r['event_id'] ?? r['arena_id'] ?? r['membership_id'] ?? null) as
      | string
      | null;
    const subject: QuestionSubjectSummary =
      subjectType === 'general'
        ? { type: 'general', id: null, name: 'General' }
        : { type: subjectType, id: subjectId, name: (r['subject_name'] as string | null) ?? '' };
    return {
      id: r['id'] as string,
      status: r['status'] as QuestionStatus,
      visibility: r['visibility'] as QuestionVisibility,
      origin: r['origin'] as QuestionOrigin,
      category: (r['category'] as QuestionCategory | null) ?? null,
      subject,
      lastMessageAt: isoOf(r['last_message_at']),
    };
  });

  const context: QuestionThreadContext = {
    member,
    contextBooking,
    recentBookings,
    memberships: membershipRows,
    priorThreads,
  };

  if (admin) {
    const actRes = await db.execute<Record<string, unknown>>(sql`
      select id, event_type, item_type, item_id, props, created_at
        from consumer_activity
       where user_id = ${userId}::uuid
       order by created_at desc
       limit ${ACTIVITY_LIMIT}
    `);
    context.recentActivity = rowsOf(actRes).map((r) => ({
      id: r['id'] as string,
      eventType: r['event_type'] as string,
      itemType: (r['item_type'] as string | null) ?? null,
      itemId: (r['item_id'] as string | null) ?? null,
      props: (r['props'] as Record<string, unknown> | null) ?? null,
      createdAt: isoOf(r['created_at']),
    }));

    const issuesRes = await db.execute<Record<string, unknown>>(sql`
      select id, source, category, status, left(message, ${EXCERPT_LEN}) as message_excerpt,
             created_at
        from support_issues
       where user_id = ${userId}::uuid
       order by created_at desc
       limit ${SUPPORT_ISSUES_LIMIT}
    `);
    context.supportIssues = rowsOf(issuesRes).map((r) => ({
      id: r['id'] as string,
      source: r['source'] as string,
      category: (r['category'] as string | null) ?? null,
      status: r['status'] as string,
      messageExcerpt: (r['message_excerpt'] as string | null) ?? '',
      createdAt: isoOf(r['created_at']),
    }));
  }

  return context;
}
