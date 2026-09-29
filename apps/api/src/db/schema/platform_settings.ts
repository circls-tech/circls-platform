import { jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { updatedAt } from './_columns.js';
import { users } from './users.js';

/**
 * Platform-wide runtime settings, keyed by name (see
 * services/payment_settings_service.ts for the payment keys). Values are
 * JSON so a new setting needs no migration.
 */
export const platformSettings = pgTable('platform_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<unknown>().notNull(),
  updatedAt: updatedAt(),
  updatedByUserId: uuid('updated_by_user_id').references(() => users.id),
});

export type PlatformSetting = typeof platformSettings.$inferSelect;
