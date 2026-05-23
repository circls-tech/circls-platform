import { integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt } from './_columns.js';

/**
 * Stored responses for idempotent POSTs. Ephemeral — swept on a TTL (Phase 12).
 * The client supplies the key; a replay returns the original status + body.
 */
export const idempotencyKeys = pgTable('idempotency_keys', {
  key: text('key').primaryKey(),
  tenantId: uuid('tenant_id'),
  statusCode: integer('status_code').notNull(),
  responseJson: jsonb('response_json').$type<unknown>().notNull(),
  createdAt: createdAt(),
});

export type IdempotencyKey = typeof idempotencyKeys.$inferSelect;
