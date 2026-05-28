import { jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { createdAt, uuidPk } from './_columns.js';
import { tenants } from './tenants.js';

/**
 * Public API keys (Phase 17). Aggregators authenticate with these to use the
 * same booking surface as circls.app. `tenant_id` null = platform-level
 * (Vedant ops only). Plaintext key is shown ONCE on create; only `key_hash`
 * (bcrypt) is persisted. `key_prefix` is the indexed shortname for lookup.
 */
export const apiKeyRole = pgEnum('api_key_role', ['read', 'write', 'admin']);
export const apiKeyStatus = pgEnum('api_key_status', ['active', 'revoked']);

export const apiKeys = pgTable('api_keys', {
  id: uuidPk(),
  /** Null = platform key (no tenant scope). */
  tenantId: uuid('tenant_id').references(() => tenants.id),
  name: text('name').notNull(),
  keyHash: text('key_hash').notNull(),
  keyPrefix: text('key_prefix').notNull(),
  role: apiKeyRole('role').notNull(),
  scopes: jsonb('scopes').$type<string[]>().notNull().default([]),
  status: apiKeyStatus('status').notNull().default('active'),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
