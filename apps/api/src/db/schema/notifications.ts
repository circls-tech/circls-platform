import { jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { createdAt, uuidPk } from './_columns.js';
import { tenants } from './tenants.js';
import { users } from './users.js';

/**
 * Outbound notification ledger (Phase 13). Every dispatch — booking confirmation,
 * OTP, reminder, KYC update — writes a row. `status='pending'` rows are picked
 * up by the dispatcher worker.
 */
export const notificationChannel = pgEnum('notification_channel', ['sms', 'email', 'whatsapp']);
export const notificationStatus = pgEnum('notification_status', [
  'pending',
  'sent',
  'failed',
  'skipped',
]);

export const notifications = pgTable('notifications', {
  id: uuidPk(),
  tenantId: uuid('tenant_id').references(() => tenants.id),
  userId: uuid('user_id').references(() => users.id),
  channel: notificationChannel('channel').notNull(),
  recipient: text('recipient').notNull(),
  templateKey: text('template_key').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  status: notificationStatus('status').notNull().default('pending'),
  providerMessageId: text('provider_message_id'),
  error: text('error'),
  scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
