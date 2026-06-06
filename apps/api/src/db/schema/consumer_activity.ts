import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { createdAt, uuidPk } from './_columns.js';

/**
 * Append-only consumer behavioral telemetry (M6). One row per logged signal
 * (screen view, search, item view, slot select, booking created/cancelled, ...).
 * Seeds the future recommendation engine. `event_type`/`item_type` are plain
 * text (no enum) on purpose so the client can add new signals without a
 * migration. `client_ts` is the device clock (untrusted); `created_at` is the
 * server truth.
 */
export const consumerActivity = pgTable('consumer_activity', {
  id: uuidPk(),
  userId: uuid('user_id').notNull(),
  sessionId: text('session_id'),
  eventType: text('event_type').notNull(),
  itemType: text('item_type'),
  itemId: uuid('item_id'),
  props: jsonb('props').$type<Record<string, unknown>>(),
  clientTs: timestamp('client_ts', { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});
export type ConsumerActivityRow = typeof consumerActivity.$inferSelect;
export type NewConsumerActivityRow = typeof consumerActivity.$inferInsert;
