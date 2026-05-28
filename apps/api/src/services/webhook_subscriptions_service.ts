/**
 * Webhook subscriptions service stub — Phase 17 owner fills these in.
 *
 * On a domain event (booking.confirmed, payment.refunded, …) we INSERT one
 * row per matching subscription into `outbound_webhook_deliveries`. The
 * delivery worker picks them up, POSTs to subscription.url with an HMAC
 * signature header (lib/webhooks/sign.ts), and retries with exponential
 * backoff up to WEBHOOK_DELIVERY_MAX_ATTEMPTS.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { logger } from '../lib/logger.js';
import {
  outboundWebhookDeliveries,
  webhookSubscriptions,
  type WebhookSubscription,
} from '../db/schema/webhooks.js';

export async function listSubscriptions(tenantId: string): Promise<WebhookSubscription[]> {
  return db
    .select()
    .from(webhookSubscriptions)
    .where(eq(webhookSubscriptions.tenantId, tenantId));
}

export interface CreateSubscriptionInput {
  tenantId: string;
  url: string;
  events: string[];
}

export interface CreateSubscriptionResult {
  id: string;
  /** Signing secret — returned once on create, never again. */
  secret: string;
}

export async function createSubscription(
  _input: CreateSubscriptionInput,
): Promise<CreateSubscriptionResult> {
  throw new Error('webhook_subscriptions_service.createSubscription not implemented — phase 17');
}

export async function deleteSubscription(
  _id: string,
  _tenantId: string,
): Promise<void> {
  throw new Error('webhook_subscriptions_service.deleteSubscription not implemented — phase 17');
}

/**
 * Fan-out for a domain event: enqueue one delivery row per active subscription
 * that's listening to this event_type. Called from booking_service /
 * payments_service / etc.
 */
export async function enqueueOutboundDeliveries(
  _eventType: string,
  _payload: Record<string, unknown>,
  _tenantId: string,
): Promise<number> {
  // TODO(phase-17): SELECT FROM webhook_subscriptions WHERE tenant_id=? AND
  // status='active' AND ? = ANY(events) → INSERT into outbound_webhook_deliveries.
  return 0;
}

/** Worker handler — runs every minute. */
export async function deliverPendingOutboundWebhooks(_concurrency: number): Promise<number> {
  // TODO(phase-17): SELECT pending + next_attempt_at <= now() ORDER BY created_at
  // LIMIT N FOR UPDATE SKIP LOCKED. For each: sign body with subscription.secret,
  // POST to subscription.url, update status / attempts / next_attempt_at.
  logger.debug('outbound_webhook_delivery_stub');
  // Silence unused-vars
  void outboundWebhookDeliveries;
  return 0;
}
