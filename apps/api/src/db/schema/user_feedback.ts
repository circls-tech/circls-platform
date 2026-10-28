import { sql } from 'drizzle-orm';
import {
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, uuidPk } from './_columns.js';
import { bookings } from './bookings.js';
import { events } from './events.js';
import { memberships, userMemberships } from './memberships.js';
import { tenants } from './tenants.js';
import { users } from './users.js';
import { venues } from './venues.js';

/**
 * Consumer feedback on what they booked (see feedback_service). Four kinds
 * share one table:
 *  - 'event_feedback': a 1–10 rating (+ optional note) once the event has
 *    ended — at most one per (user, event).
 *  - 'venue_feedback': the same for a court booking, a day after check-in —
 *    one per (user, booking).
 *  - 'membership_feedback': the same for a membership, a day after the first
 *    check-in — one per (user, purchase).
 *  - 'event_type_preference': the answer to "What kind of event would you like
 *    to see next on Circls?" — at most one per user; `comment` holds what they
 *    typed when they chose "Other".
 */
export const userFeedbackKind = pgEnum('user_feedback_kind', [
  'event_feedback',
  'venue_feedback',
  'membership_feedback',
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
    /** The org whose listing was rated (null for the poll). */
    tenantId: uuid('tenant_id').references(() => tenants.id),
    eventId: uuid('event_id').references(() => events.id),
    /** The registration or court booking the rating is about. */
    bookingId: uuid('booking_id').references(() => bookings.id),
    venueId: uuid('venue_id').references(() => venues.id),
    membershipId: uuid('membership_id').references(() => memberships.id),
    userMembershipId: uuid('user_membership_id').references(() => userMemberships.id),
    /** 1–10 for the three rating kinds (CHECK in migration). */
    rating: integer('rating'),
    /** The optional note on a rating, or the poll's "Other" text. */
    comment: text('comment'),
    /** Stable id of the poll question (event_type_preference only). */
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
    uniqueIndex('user_feedback_venue_uq')
      .on(t.userId, t.bookingId)
      .where(sql`${t.kind} = 'venue_feedback'`),
    uniqueIndex('user_feedback_membership_uq')
      .on(t.userId, t.userMembershipId)
      .where(sql`${t.kind} = 'membership_feedback'`),
    uniqueIndex('user_feedback_pref_uq')
      .on(t.userId)
      .where(sql`${t.kind} = 'event_type_preference'`),
  ],
);

export type UserFeedback = typeof userFeedback.$inferSelect;
export type NewUserFeedback = typeof userFeedback.$inferInsert;

/**
 * The website survey: once per consumer, and once per partner organisation
 * (whichever Owner or Manager answers first answers for the org). Area ratings
 * are null when the person said they haven't tried that part yet.
 */
export const siteFeedbackAudience = pgEnum('site_feedback_audience', ['consumer', 'partner']);

export const siteFeedback = pgTable(
  'site_feedback',
  {
    id: uuidPk(),
    audience: siteFeedbackAudience('audience').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    /** Partner answers only: the org answered for. */
    tenantId: uuid('tenant_id').references(() => tenants.id),
    /** Contact snapshots at submission time, as on user_feedback. */
    phoneE164: text('phone_e164'),
    email: text('email'),
    overallRating: integer('overall_rating').notNull(),
    /** Consumer: finding things to do. */
    discoveryRating: integer('discovery_rating'),
    /** Consumer: booking and paying. */
    bookingRating: integer('booking_rating'),
    /** Partner: creating an event / a venue / a membership plan. */
    eventCreationRating: integer('event_creation_rating'),
    venueCreationRating: integer('venue_creation_rating'),
    membershipCreationRating: integer('membership_creation_rating'),
    challenges: text('challenges'),
    comments: text('comments'),
    source: text('source').notNull().default('consumer'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('site_feedback_consumer_uq')
      .on(t.userId)
      .where(sql`${t.audience} = 'consumer'`),
    uniqueIndex('site_feedback_partner_uq')
      .on(t.tenantId)
      .where(sql`${t.audience} = 'partner'`),
  ],
);

export type SiteFeedback = typeof siteFeedback.$inferSelect;
export type NewSiteFeedback = typeof siteFeedback.$inferInsert;

/**
 * "Not now" on a feedback prompt, per person and prompt. A rating or the poll
 * dismissed once is never asked again; the website survey comes back a week
 * after each dismissal until it is answered.
 */
export const feedbackDismissals = pgTable(
  'feedback_dismissals',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 'event:<id>', 'venue:<bookingId>', 'membership:<id>', 'poll', 'site'
     *  or 'partner:<tenantId>'. */
    promptKey: text('prompt_key').notNull(),
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }).notNull().defaultNow(),
    times: integer('times').notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.userId, t.promptKey], name: 'feedback_dismissals_pk' })],
);
