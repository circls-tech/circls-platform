import { pgTable, primaryKey, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users.js';

/**
 * A consumer's "Block this person" on question threads (App Store guideline
 * 1.2). Personal, not moderation: the blocked user's public threads and
 * replies stop being shown to the blocker, and nobody else is affected. The
 * blocker never learns the blocked user's id — the block is placed by thread
 * or message and resolved to its author server-side.
 */
export const userBlocks = pgTable(
  'user_blocks',
  {
    blockerUserId: uuid('blocker_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    blockedUserId: uuid('blocked_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.blockerUserId, t.blockedUserId] })],
);

export type UserBlock = typeof userBlocks.$inferSelect;
