import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { isUniqueViolation } from '../db/errors.js';
import { userFeedback } from '../db/schema/user_feedback.js';
import type { User } from '../db/schema/users.js';
import { BadRequest, Conflict, NotFound } from '../lib/errors.js';

/**
 * Post-login feedback prompts (consumer portal + mobile app):
 *  - Consumers who registered for an event that has already ended are asked
 *    "how was the event" (1–5 rating + optional comment), once per event.
 *  - Consumers with NO bookings at all are instead served one randomly-picked
 *    multiple-choice question about what event types they'd like listed,
 *    answered at most once per user.
 * Every submission snapshots the user's phone number (users.phone_e164) so the
 * feedback stays attached to the phone in the database.
 */

export interface EventTypeQuestion {
  key: string;
  question: string;
  options: string[];
}

/**
 * The MCQ pool for first-time users. Keys are stable ids stored alongside a
 * text snapshot of the served wording, so entries can be reworded or retired
 * without orphaning old answers.
 */
export const EVENT_TYPE_QUESTIONS: EventTypeQuestion[] = [
  {
    key: 'event_types_v1_general',
    question: 'What type of events would you like to see on Circls?',
    options: [
      'Sports & fitness',
      'Music & concerts',
      'Workshops & classes',
      'Comedy & theatre',
      'Food & social meetups',
    ],
  },
  {
    key: 'event_types_v1_first_booking',
    question: 'Which of these would get you to book your first event?',
    options: [
      'A casual sports game near me',
      'A live gig or concert',
      'A hands-on workshop',
      'A stand-up comedy night',
      'A community meetup',
    ],
  },
  {
    key: 'event_types_v1_weekend',
    question: 'How would you most like to spend a free weekend?',
    options: [
      'Playing or watching sports',
      'At a concert or festival',
      'Learning something new',
      'Laughing at a comedy show',
      'Hanging out at a social event',
    ],
  },
];

/** A past event the consumer registered for and hasn't reviewed yet. */
export interface EventFeedbackPrompt {
  kind: 'event_feedback';
  event: { id: string; name: string; endsAt: string; venueName: string | null };
}

export interface EventTypePreferencePrompt {
  kind: 'event_type_preference';
  question: EventTypeQuestion;
}

export type FeedbackPrompt = EventFeedbackPrompt | EventTypePreferencePrompt;

/**
 * A registration that qualifies for event feedback: an event-type booking that
 * wasn't cancelled or a no-show, whose event has already ended.
 */
const QUALIFYING_BOOKING = (userId: string) => sql`
  b.item_type = 'event'
  and b.status in ('confirmed', 'completed')
  and (b.created_by_user_id = ${userId} or b.customer_user_id = ${userId})
`;

/**
 * Decide which prompt (if any) to show this consumer after login:
 * most-recently-ended unreviewed past event first; otherwise, for users with
 * no bookings at all, a random unanswered event-type MCQ; otherwise null.
 */
export async function getFeedbackPrompt(userId: string): Promise<FeedbackPrompt | null> {
  const pastEvents = (await db.execute<Record<string, unknown>>(sql`
    select ev.id, ev.name, ev.ends_at, v.name as venue_name
    from bookings b
    join events ev on ev.id = nullif(b.item_data->>'eventId', '')::uuid
    left join venues v on v.id = ev.venue_id
    where ${QUALIFYING_BOOKING(userId)}
      and ev.ends_at < now()
      and not exists (
        select 1 from user_feedback f
        where f.user_id = ${userId} and f.kind = 'event_feedback' and f.event_id = ev.id
      )
    order by ev.ends_at desc
    limit 1
  `)) as unknown as Record<string, unknown>[];
  const past = pastEvents[0];
  if (past) {
    return {
      kind: 'event_feedback',
      event: {
        id: past['id'] as string,
        name: past['name'] as string,
        endsAt: new Date(past['ends_at'] as string).toISOString(),
        venueName: (past['venue_name'] as string | null) ?? null,
      },
    };
  }

  const counts = (await db.execute<Record<string, unknown>>(sql`
    select
      (select count(*) from bookings b
        where b.created_by_user_id = ${userId} or b.customer_user_id = ${userId}) as booking_count,
      (select count(*) from user_feedback f
        where f.user_id = ${userId} and f.kind = 'event_type_preference') as pref_count
  `)) as unknown as Record<string, unknown>[];
  const bookingCount = Number(counts[0]?.['booking_count'] ?? 0);
  const prefCount = Number(counts[0]?.['pref_count'] ?? 0);
  if (bookingCount > 0 || prefCount > 0) return null;

  const question =
    EVENT_TYPE_QUESTIONS[Math.floor(Math.random() * EVENT_TYPE_QUESTIONS.length)];
  if (!question) return null;
  return { kind: 'event_type_preference', question };
}

export interface SubmittedFeedback {
  id: string;
  kind: 'event_feedback' | 'event_type_preference';
  createdAt: string;
}

/**
 * Record the consumer's rating for a past event they registered for. The
 * qualifying-booking check keeps drive-by reviews out; the partial unique
 * index (surfaced as a friendly Conflict) keeps it to one per (user, event).
 */
export async function submitEventFeedback(
  user: User,
  input: { eventId: string; rating: number; comment?: string; source?: string },
): Promise<SubmittedFeedback> {
  const qualifying = (await db.execute<Record<string, unknown>>(sql`
    select b.id
    from bookings b
    join events ev on ev.id = nullif(b.item_data->>'eventId', '')::uuid
    where ${QUALIFYING_BOOKING(user.id)}
      and ev.id = ${input.eventId}
      and ev.ends_at < now()
    order by b.created_at desc
    limit 1
  `)) as unknown as Record<string, unknown>[];
  const booking = qualifying[0];
  if (!booking) {
    throw new NotFound(
      'No past registration found for this event',
      'feedback_event_not_eligible',
    );
  }
  try {
    const [row] = await db
      .insert(userFeedback)
      .values({
        userId: user.id,
        phoneE164: user.phoneE164,
        kind: 'event_feedback',
        eventId: input.eventId,
        bookingId: booking['id'] as string,
        rating: input.rating,
        comment: input.comment?.trim() ? input.comment.trim() : null,
        source: input.source ?? 'consumer',
      })
      .returning();
    if (!row) throw new Conflict('Feedback already submitted', 'feedback_exists');
    return { id: row.id, kind: 'event_feedback', createdAt: row.createdAt.toISOString() };
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new Conflict('Feedback already submitted for this event', 'feedback_exists');
    }
    throw err;
  }
}

/**
 * Record the consumer's answer to one of the event-type preference questions.
 * The answer must be one of the served question's options; one answer per user
 * (partial unique index → friendly Conflict).
 */
export async function submitEventTypePreference(
  user: User,
  input: { questionKey: string; answer: string; source?: string },
): Promise<SubmittedFeedback> {
  const question = EVENT_TYPE_QUESTIONS.find((q) => q.key === input.questionKey);
  if (!question) {
    throw new BadRequest('Unknown question', 'feedback_unknown_question');
  }
  if (!question.options.includes(input.answer)) {
    throw new BadRequest('Answer must be one of the offered options', 'feedback_invalid_answer');
  }
  try {
    const [row] = await db
      .insert(userFeedback)
      .values({
        userId: user.id,
        phoneE164: user.phoneE164,
        kind: 'event_type_preference',
        questionKey: question.key,
        question: question.question,
        answer: input.answer,
        source: input.source ?? 'consumer',
      })
      .returning();
    if (!row) throw new Conflict('Preference already submitted', 'feedback_exists');
    return {
      id: row.id,
      kind: 'event_type_preference',
      createdAt: row.createdAt.toISOString(),
    };
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new Conflict('Preference already submitted', 'feedback_exists');
    }
    throw err;
  }
}
