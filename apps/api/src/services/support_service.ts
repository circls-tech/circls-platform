/**
 * Support concerns service (epic #106). Historical reads for the consumer
 * Help-chatbot channel plus the admin triage list:
 *
 *  - listConsumerConcerns: the caller's own chatbot concerns, newest first.
 *  - listAdminSupportIssues: admin triage list across BOTH sources, with
 *    optional source/category/status filters and resolved booking context.
 *
 * The consumer *intake* (createConsumerConcern) was removed by the
 * support→threads design (2026-07-18): new consumer concerns are private
 * question threads (`POST /v1/consumer/questions` with `origin: 'support'`,
 * see questions_service.createSupportThread). Existing `consumer_chatbot`
 * rows stay readable here; the partner submit path (POST /v1/support/issues)
 * and admin PATCH are untouched.
 */
import { and, desc, eq, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { bookings } from '../db/schema/bookings.js';
import {
  supportIssues,
  venues,
  type SupportIssue,
} from '../db/schema/index.js';

export type SupportIssueSource = (typeof supportIssues.source.enumValues)[number];
export type SupportIssueCategory = (typeof supportIssues.category.enumValues)[number];
export type SupportIssueStatus = (typeof supportIssues.status.enumValues)[number];

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
