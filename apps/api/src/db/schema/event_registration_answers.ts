import { pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, uuidPk } from './_columns.js';
import { bookings } from './bookings.js';
import { eventRegistrationQuestions } from './event_registration_questions.js';

/**
 * One consumer's answer to one registration question, captured at booking time.
 * A single event booking is still ONE bookings row; its answers are this set.
 * `questionLabel` is a snapshot so exports keep working even after the question
 * row is soft-deleted or the event is long gone.
 */
export const eventRegistrationAnswers = pgTable(
  'event_registration_answers',
  {
    id: uuidPk(),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => bookings.id, { onDelete: 'cascade' }),
    questionId: uuid('question_id')
      .notNull()
      .references(() => eventRegistrationQuestions.id),
    /** Question label at booking time (the question may be edited later). */
    questionLabel: text('question_label').notNull(),
    answer: text('answer').notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    // One answer per question per booking; the app-level duplicate check in
    // saveRegistrationAnswers is the friendly error, this is the backstop.
    bookingQuestionUniq: uniqueIndex('event_registration_answers_booking_question_uq').on(
      t.bookingId,
      t.questionId,
    ),
  }),
);

export type EventRegistrationAnswer = typeof eventRegistrationAnswers.$inferSelect;
export type NewEventRegistrationAnswer = typeof eventRegistrationAnswers.$inferInsert;
