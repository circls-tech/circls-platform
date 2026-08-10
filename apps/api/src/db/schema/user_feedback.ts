import { sql } from 'drizzle-orm';
import { integer, pgEnum, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, uuidPk } from './_columns.js';
import { bookings } from './bookings.js';
import { events } from './events.js';
import { users } from './users.js';

/**
 * Post-login consumer feedback (issue: "how was the event" + event-type
 * preference poll). Two kinds share one table:
 *  - 'event_feedback': a rating (+ optional comment) for a past event the
 *    consumer had registered for — at most one per (user, event).
 *  - 'event_type_preference': the answer to one randomly-served multiple-choice
 *    question about what event types they'd like listed — at most one per user.
 */
export const userFeedbackKind = pgEnum('user_feedback_kind', [
  'event_feedback',
  'event_type_preference',
]);

export const userFeedback = pgTable(
  'user_feedback',
  {
    id: uuidPk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    /**
     * E.164 snapshot of users.phone_e164 at submission time, so feedback stays
     * attached to the phone number even if the user row's phone later changes
     * or the row is merged. users.id remains the canonical FK.
     */
    phoneE164: text('phone_e164'),
    kind: userFeedbackKind('kind').notNull(),
    eventId: uuid('event_id').references(() => events.id),
    /** The qualifying registration the event feedback is about (best match). */
    bookingId: uuid('booking_id').references(() => bookings.id),
    /** 1–5, event_feedback only (CHECK in migration). */
    rating: integer('rating'),
    comment: text('comment'),
    /** Stable id of the served MCQ variant (event_type_preference only). */
    questionKey: text('question_key'),
    /** Question text snapshot — pool entries may be reworded later. */
    question: text('question'),
    answer: text('answer'),
    /** Submitting client, mirroring login_events.source. */
    source: text('source').notNull().default('consumer'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('user_feedback_event_uq')
      .on(t.userId, t.eventId)
      .where(sql`${t.kind} = 'event_feedback'`),
    uniqueIndex('user_feedback_pref_uq')
      .on(t.userId)
      .where(sql`${t.kind} = 'event_type_preference'`),
  ],
);

export type UserFeedback = typeof userFeedback.$inferSelect;
export type NewUserFeedback = typeof userFeedback.$inferInsert;
