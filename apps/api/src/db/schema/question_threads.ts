import { integer, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { createdAt, updatedAt, uuidPk } from './_columns.js';
import { arenas } from './arenas.js';
import { events } from './events.js';
import { memberships } from './memberships.js';
import { tenants } from './tenants.js';
import { users } from './users.js';

/**
 * Questions threads (epic #106 follow-on). A consumer asks a question on an
 * event, arena, or membership; the question is a thread of chat-style messages
 * (see question_messages.ts). Visibility is chosen at creation and immutable:
 * `private` (author + owning org + Circls) or `public` (readable by everyone,
 * any signed-in user can reply).
 */
export const questionSubjectType = pgEnum('question_subject_type', [
  'event',
  'arena',
  'membership',
]);

export const questionVisibility = pgEnum('question_visibility', ['public', 'private']);

/**
 * Lifecycle: open → answered → closed.
 * - org/circls reply on `open` → auto-`answered`
 * - author reply on `answered` → back to `open`
 * - replies on `closed` are rejected everywhere (reopen via status PATCH first)
 */
export const questionStatus = pgEnum('question_status', ['open', 'answered', 'closed']);

export const questionThreads = pgTable('question_threads', {
  id: uuidPk(),
  /** Denormalized owner of the subject — drives org authz + the org inbox. */
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  subjectType: questionSubjectType('subject_type').notNull(),
  // Exactly one of the three subject FKs is set, matching subject_type
  // (DB CHECK `question_threads_subject_chk`).
  eventId: uuid('event_id').references(() => events.id),
  arenaId: uuid('arena_id').references(() => arenas.id),
  membershipId: uuid('membership_id').references(() => memberships.id),
  /** Immutable after creation. */
  visibility: questionVisibility('visibility').notNull(),
  status: questionStatus('status').notNull().default('open'),
  authorUserId: uuid('author_user_id')
    .notNull()
    .references(() => users.id),
  /** Bumped on every message; the sort key for all listings. */
  lastMessageAt: timestamp('last_message_at', { withTimezone: true }).notNull().defaultNow(),
  /** Maintained transactionally alongside message inserts (root counts as 1). */
  messageCount: integer('message_count').notNull().default(1),
  /**
   * Thread-level moderation (abusive/malicious threads): an archived thread
   * disappears from EVERY consumer surface — 404 for the author too — while
   * staff (org + Circls) retain access. Staff replies/status/hide are rejected
   * (409 question_archived) until it is unarchived.
   */
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  archivedByUserId: uuid('archived_by_user_id').references(() => users.id),
  /**
   * Who archived the thread: 'org' (partner) or 'circls' (admin). Drives the
   * unarchive hierarchy — the org can only undo its own archives; Circls can
   * unarchive anything (same shape as question_messages.hidden_by_kind).
   */
  archivedByKind: text('archived_by_kind', { enum: ['org', 'circls'] }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type QuestionThread = typeof questionThreads.$inferSelect;
export type NewQuestionThread = typeof questionThreads.$inferInsert;
export type QuestionSubjectType = (typeof questionSubjectType.enumValues)[number];
export type QuestionVisibility = (typeof questionVisibility.enumValues)[number];
export type QuestionStatus = (typeof questionStatus.enumValues)[number];
