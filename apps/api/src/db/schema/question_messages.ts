import { pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { createdAt, updatedAt, uuidPk } from './_columns.js';
import { questionThreads } from './question_threads.js';
import { users } from './users.js';

/**
 * Who a message was posted *as*, stamped at write time from the poster's
 * relationship to the thread: platform-tenant member → `circls`, member of the
 * thread's tenant → `org`, everyone else → `consumer`. A user who is both the
 * asker and an org member posts as `org` (accepted edge, see design doc).
 */
export const questionAuthorKind = pgEnum('question_author_kind', [
  'consumer',
  'org',
  'circls',
]);

/**
 * One chat-style message in a question thread. The **root message** is simply
 * the earliest message of its thread (no special flag). `hidden_at` is
 * moderation: org can hide non-root replies on public threads it owns; Circls
 * admin can hide any message on public threads (root included).
 */
export const questionMessages = pgTable('question_messages', {
  id: uuidPk(),
  threadId: uuid('thread_id')
    .notNull()
    .references(() => questionThreads.id, { onDelete: 'cascade' }),
  authorUserId: uuid('author_user_id')
    .notNull()
    .references(() => users.id),
  authorKind: questionAuthorKind('author_kind').notNull(),
  /** 1–2000 chars, trimmed, non-empty — enforced at the API boundary. */
  body: text('body').notNull(),
  hiddenAt: timestamp('hidden_at', { withTimezone: true }),
  hiddenByUserId: uuid('hidden_by_user_id').references(() => users.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type QuestionMessage = typeof questionMessages.$inferSelect;
export type NewQuestionMessage = typeof questionMessages.$inferInsert;
export type QuestionAuthorKind = (typeof questionAuthorKind.enumValues)[number];
