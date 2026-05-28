import { integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { createdAt, uuidPk } from './_columns.js';
import { tenants } from './tenants.js';

/**
 * Outbound webhook subscriptions (Phase 17). Tenants subscribe to booking /
 * payment lifecycle events. Each delivery attempt is logged in
 * `outbound_webhook_deliveries`, signed with the subscription's secret (HMAC).
 */
export const webhookStatus = pgEnum('webhook_subscription_status', ['active', 'disabled']);

export const webhookSubscriptions = pgTable('webhook_subscriptions', {
  id: uuidPk(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  url: text('url').notNull(),
  secret: text('secret').notNull(),
  /** ['booking.confirmed', 'booking.cancelled', 'payment.refunded', ...] */
  events: text('events').array().notNull(),
  status: webhookStatus('status').notNull().default('active'),
  createdAt: createdAt(),
});

export type WebhookSubscription = typeof webhookSubscriptions.$inferSelect;
export type NewWebhookSubscription = typeof webhookSubscriptions.$inferInsert;

export const webhookDeliveryStatus = pgEnum('webhook_delivery_status', [
  'pending',
  'delivered',
  'failed',
  'expired',
]);

export const outboundWebhookDeliveries = pgTable('outbound_webhook_deliveries', {
  id: uuidPk(),
  subscriptionId: uuid('subscription_id')
    .notNull()
    .references(() => webhookSubscriptions.id, { onDelete: 'cascade' }),
  eventType: text('event_type').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  status: webhookDeliveryStatus('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  lastError: text('last_error'),
  createdAt: createdAt(),
});

export type OutboundWebhookDelivery = typeof outboundWebhookDeliveries.$inferSelect;
export type NewOutboundWebhookDelivery = typeof outboundWebhookDeliveries.$inferInsert;
