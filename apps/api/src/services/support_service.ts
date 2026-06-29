/**
 * Support concerns service (epic #106). Extends the existing partner
 * `support_issues` system with the consumer Help-chatbot channel:
 *
 *  - createConsumerConcern: validates an optional booking link belongs to the
 *    caller (same `customer_user_id OR created_by_user_id` ownership rule as
 *    listMyBookings), then inserts a `source = consumer_chatbot` row.
 *  - listConsumerConcerns: the caller's own chatbot concerns, newest first.
 *  - listAdminSupportIssues: admin triage list across BOTH sources, with
 *    optional source/category/status filters and resolved booking context.
 *
 * The partner submit path (POST /v1/support/issues) and admin PATCH are
 * untouched and continue to write `source = partner_help` via the column default.
 */
import { and, desc, eq, or, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { bookings } from '../db/schema/bookings.js';
import {
  supportIssues,
  venues,
  type FlowAnswer,
  type SupportIssue,
} from '../db/schema/index.js';
import { NotFound } from '../lib/errors.js';

export type SupportIssueSource = (typeof supportIssues.source.enumValues)[number];
export type SupportIssueCategory = (typeof supportIssues.category.enumValues)[number];
export type SupportIssueStatus = (typeof supportIssues.status.enumValues)[number];

export interface CreateConsumerConcernInput {
  userId: string;
  category: SupportIssueCategory;
  bookingId?: string | undefined;
  flowAnswers: FlowAnswer[];
  message: string;
}

/**
 * Create a consumer-sourced support concern. If a `bookingId` is supplied it
 * MUST belong to the caller (as customer or creator); otherwise we 404 so a
 * user can't attach someone else's booking. Returns the created row.
 */
export async function createConsumerConcern(
  input: CreateConsumerConcernInput,
): Promise<SupportIssue> {
  if (input.bookingId) {
    const [owned] = await db
      .select({ id: bookings.id })
      .from(bookings)
      .where(
        and(
          eq(bookings.id, input.bookingId),
          or(
            eq(bookings.customerUserId, input.userId),
            eq(bookings.createdByUserId, input.userId),
          ),
        ),
      )
      .limit(1);
    if (!owned) throw new NotFound('Booking not found', 'booking_not_found');
  }

  const [issue] = await db
    .insert(supportIssues)
    .values({
      userId: input.userId,
      message: input.message,
      source: 'consumer_chatbot',
      category: input.category,
      bookingId: input.bookingId ?? null,
      flowAnswers: input.flowAnswers,
    })
    .returning();
  return issue!;
}

/** The caller's own chatbot-sourced concerns, newest first (for "your past enquiries"). */
export async function listConsumerConcerns(userId: string): Promise<SupportIssue[]> {
  return db
    .select()
    .from(supportIssues)
    .where(
      and(eq(supportIssues.userId, userId), eq(supportIssues.source, 'consumer_chatbot')),
    )
    .orderBy(desc(supportIssues.createdAt));
}

/** Resolved booking context for an admin row; null when the issue has no booking. */
export interface AdminBookingContext {
  id: string;
  venueName: string | null;
  status: string;
  itemType: string;
}

/** A support issue enriched for admin triage: every column plus booking context. */
export interface AdminSupportIssueRow extends SupportIssue {
  booking: AdminBookingContext | null;
}

export interface AdminSupportIssueFilters {
  source?: SupportIssueSource | undefined;
  category?: SupportIssueCategory | undefined;
  status?: SupportIssueStatus | undefined;
}

/**
 * Admin triage list across partner + consumer issues, newest first. LEFT JOINs
 * the linked booking (and its venue) so the admin UI can show booking context
 * without an N+1. Optional source/category/status filters narrow the list.
 */
export async function listAdminSupportIssues(
  filters: AdminSupportIssueFilters = {},
): Promise<AdminSupportIssueRow[]> {
  const conds: SQL[] = [];
  if (filters.source) conds.push(eq(supportIssues.source, filters.source));
  if (filters.category) conds.push(eq(supportIssues.category, filters.category));
  if (filters.status) conds.push(eq(supportIssues.status, filters.status));

  const rows = await db
    .select({
      issue: supportIssues,
      bookingItemType: bookings.itemType,
      bookingStatus: bookings.status,
      venueName: venues.name,
    })
    .from(supportIssues)
    .leftJoin(bookings, eq(bookings.id, supportIssues.bookingId))
    .leftJoin(venues, eq(venues.id, bookings.venueId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(supportIssues.createdAt));

  return rows.map((r) => ({
    ...r.issue,
    booking: r.issue.bookingId
      ? {
          id: r.issue.bookingId,
          venueName: r.venueName ?? null,
          status: r.bookingStatus ?? 'unknown',
          itemType: r.bookingItemType ?? 'unknown',
        }
      : null,
  }));
}
