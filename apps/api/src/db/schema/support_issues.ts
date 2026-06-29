import { jsonb, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, updatedAt, uuidPk } from './_columns.js';
import { bookings } from './bookings.js';
import { users } from './users.js';

export const supportIssueStatus = pgEnum('support_issue_status', [
  'unresolved',
  'in_progress',
  'backlog',
  'resolved',
]);

export const supportIssuePriority = pgEnum('support_issue_priority', [
  'low',
  'medium',
  'high',
]);

/**
 * Channel the issue came in on. The existing partner Help Centre submits are
 * `partner_help` (the migration backfills every pre-existing row to this); the
 * consumer Help chatbot logs `consumer_chatbot`.
 */
export const supportIssueSource = pgEnum('support_issue_source', [
  'partner_help',
  'consumer_chatbot',
]);

/**
 * Coarse triage category for a concern. Only consumer-chatbot rows carry one
 * (partner rows leave it null), so the column is nullable.
 */
export const supportIssueCategory = pgEnum('support_issue_category', [
  'booking_issue',
  'refund_request',
  'reschedule',
  'venue_question',
  'payment',
  'other',
]);

/** One step of the MCQ flow the consumer walked: the question and their answer. */
export interface FlowAnswer {
  question: string;
  answer: string;
}

export const supportIssues = pgTable('support_issues', {
  id: uuidPk(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  message: text('message').notNull(),
  status: supportIssueStatus('status').notNull().default('unresolved'),
  priority: supportIssuePriority('priority').notNull().default('medium'),
  // Consumer-Help extensions (epic #106). `source` defaults to partner_help so
  // the existing partner submit path is unchanged and pre-existing rows backfill
  // cleanly.
  source: supportIssueSource('source').notNull().default('partner_help'),
  category: supportIssueCategory('category'),
  bookingId: uuid('booking_id').references(() => bookings.id),
  flowAnswers: jsonb('flow_answers').$type<FlowAnswer[]>(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type SupportIssue = typeof supportIssues.$inferSelect;
export type NewSupportIssue = typeof supportIssues.$inferInsert;
