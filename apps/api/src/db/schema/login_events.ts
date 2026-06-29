import { pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, uuidPk } from './_columns.js';

/**
 * Append-only login audit. One row per *fresh* sign-in (the frontends call
 * POST /v1/me/login after a successful credential exchange — not on every
 * page load / session restore). `source` records which portal the login came
 * from ('consumer' | 'partners' | 'admin'); it is plain text so a new portal
 * can record logins without a migration. Powers the admin dashboard's login
 * and active-user tiles.
 */
export const loginEvents = pgTable('login_events', {
  id: uuidPk(),
  userId: uuid('user_id').notNull(),
  source: text('source'),
  createdAt: createdAt(),
});

export type LoginEventRow = typeof loginEvents.$inferSelect;
export type NewLoginEventRow = typeof loginEvents.$inferInsert;
