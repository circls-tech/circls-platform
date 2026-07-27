import { boolean, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { createdAt, updatedAt, uuidPk } from './_columns.js';
import { events } from './events.js';
import { tenants } from './tenants.js';

/** How a registration question is answered: free text, or one of `options`. */
export type RegistrationQuestionType = 'text' | 'select';

/**
 * A custom registration question the organiser asks every consumer who books
 * the event ("T-shirt size?", "Any dietary restrictions?"). Questions are
 * editable only while the parent event is draft (replace-all from the event
 * payload, like ticket tiers) and are soft-deleted (deletedAt) when removed so
 * historical answers keep referencing the question they were asked under.
 */
export const eventRegistrationQuestions = pgTable('event_registration_questions', {
  id: uuidPk(),
  eventId: uuid('event_id')
    .notNull()
    .references(() => events.id, { onDelete: 'cascade' }),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  label: text('label').notNull(),
  type: text('type').$type<RegistrationQuestionType>().notNull().default('text'),
  required: boolean('required').notNull().default(false),
  /** Choices for 'select' questions; null for free-text. */
  options: jsonb('options').$type<string[]>(),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export type EventRegistrationQuestion = typeof eventRegistrationQuestions.$inferSelect;
export type NewEventRegistrationQuestion = typeof eventRegistrationQuestions.$inferInsert;
