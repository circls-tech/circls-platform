/**
 * Webhook subscriptions service (Phase 17).
 *
 * Tenants subscribe to domain events (booking.confirmed, payment.refunded, …).
 * `enqueueOutboundDeliveries` fans out one `outbound_webhook_deliveries` row per
 * matching active subscription. A 1-min worker (`deliverPendingOutboundWebhooks`)
 * locks pending rows with `FOR UPDATE SKIP LOCKED`, signs the body with the
 * subscription's secret, POSTs to the URL, and applies exponential backoff
 * (capped at 1h) up to WEBHOOK_DELIVERY_MAX_ATTEMPTS.
 */
import crypto from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { logger } from '../lib/logger.js';
import { signWebhook } from '../lib/webhooks/sign.js';
import {
  outboundWebhookDeliveries,
  type OutboundWebhookDelivery,
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

function makeSecret(): string {
  return crypto.randomBytes(24).toString('base64url');
}

export async function createSubscription(
  input: CreateSubscriptionInput,
): Promise<CreateSubscriptionResult> {
  const secret = makeSecret();
  const [row] = await db
    .insert(webhookSubscriptions)
    .values({
      tenantId: input.tenantId,
      url: input.url,
      events: input.events,
      secret,
    })
    .returning();
  if (!row) throw new Error('webhook_subscription_insert_failed');
  return { id: row.id, secret };
}

export async function deleteSubscription(id: string, tenantId: string): Promise<void> {
  // Cascade drops deliveries (FK has ON DELETE CASCADE).
  await db
    .delete(webhookSubscriptions)
    .where(and(eq(webhookSubscriptions.id, id), eq(webhookSubscriptions.tenantId, tenantId)));
}

/**
 * Fan-out for a domain event: one delivery row per active subscription that's
 * listening to `eventType`. Called from booking/payments/etc. services.
 */
export async function enqueueOutboundDeliveries(
  eventType: string,
  payload: Record<string, unknown>,
  tenantId: string,
): Promise<number> {
  const matching = await db
    .select()
    .from(webhookSubscriptions)
    .where(
      and(
        eq(webhookSubscriptions.tenantId, tenantId),
        eq(webhookSubscriptions.status, 'active'),
        // text[]: `? = ANY(events)` filter (the PG idiom that matches the
        // delivery model best; no GIN index needed for the small per-tenant
        // subscription counts we expect).
        sql`${eventType} = ANY(${webhookSubscriptions.events})`,
      ),
    );

  if (matching.length === 0) return 0;

  await db.insert(outboundWebhookDeliveries).values(
    matching.map((sub) => ({
      subscriptionId: sub.id,
      eventType,
      payload,
      status: 'pending' as const,
      nextAttemptAt: new Date(),
      attempts: 0,
    })),
  );

  return matching.length;
}

interface PendingDeliveryRow {
  delivery: OutboundWebhookDelivery;
  subscription: WebhookSubscription;
}

const DELIVERY_BATCH = 25;
const DELIVERY_TIMEOUT_MS = 10_000;

async function postSignedWebhook(
  url: string,
  rawBody: string,
  signatureHeader: string,
): Promise<{ ok: boolean; status: number; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Circls-Signature': signatureHeader,
      },
      body: rawBody,
      signal: controller.signal,
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Cap of 60 minutes (1h) per task spec; 2^attempts otherwise. */
function backoffMinutes(attempts: number): number {
  return Math.min(2 ** attempts, 60);
}

async function processOne(row: PendingDeliveryRow): Promise<void> {
  const { delivery, subscription } = row;
  const rawBody = JSON.stringify({
    event_type: delivery.eventType,
    payload: delivery.payload,
    delivery_id: delivery.id,
  });
  const { signatureHeader } = signWebhook(rawBody, subscription.secret);
  const res = await postSignedWebhook(subscription.url, rawBody, signatureHeader);

  const nextAttempts = delivery.attempts + 1;

  if (res.ok) {
    await db
      .update(outboundWebhookDeliveries)
      .set({
        status: 'delivered',
        deliveredAt: new Date(),
        attempts: nextAttempts,
        lastError: null,
      })
      .where(eq(outboundWebhookDeliveries.id, delivery.id));
    return;
  }

  const lastError = res.error ?? `http_${res.status}`;
  if (nextAttempts >= env.WEBHOOK_DELIVERY_MAX_ATTEMPTS) {
    await db
      .update(outboundWebhookDeliveries)
      .set({
        status: 'failed',
        attempts: nextAttempts,
        lastError,
        nextAttemptAt: null,
      })
      .where(eq(outboundWebhookDeliveries.id, delivery.id));
    return;
  }

  const nextAttemptAt = new Date(Date.now() + backoffMinutes(nextAttempts) * 60_000);
  await db
    .update(outboundWebhookDeliveries)
    .set({
      attempts: nextAttempts,
      lastError,
      nextAttemptAt,
    })
    .where(eq(outboundWebhookDeliveries.id, delivery.id));
}

/** Limit-N concurrent runner. Returns when every promise has settled. */
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = items.slice();
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      try {
        await fn(next);
      } catch (err) {
        logger.error({ err }, 'webhook_delivery_unhandled');
      }
    }
  });
  await Promise.all(workers);
}

/** Worker handler — runs every minute. */
export async function deliverPendingOutboundWebhooks(concurrency: number): Promise<number> {
  // Lock + claim a batch in a single transaction. Postgres `FOR UPDATE SKIP LOCKED`
  // is what gives us safe horizontal scaling later (no double-delivery if N workers run).
  const claimed = await db.transaction(async (tx) => {
    const rows = await tx.execute<Record<string, unknown>>(sql`
      SELECT
        d.id            AS d_id,
        d.subscription_id AS d_subscription_id,
        d.event_type    AS d_event_type,
        d.payload       AS d_payload,
        d.status        AS d_status,
        d.attempts      AS d_attempts,
        d.next_attempt_at AS d_next_attempt_at,
        d.delivered_at  AS d_delivered_at,
        d.last_error    AS d_last_error,
        d.created_at    AS d_created_at,
        s.id            AS s_id,
        s.tenant_id     AS s_tenant_id,
        s.url           AS s_url,
        s.secret        AS s_secret,
        s.events        AS s_events,
        s.status        AS s_status,
        s.created_at    AS s_created_at
      FROM outbound_webhook_deliveries d
      JOIN webhook_subscriptions s ON s.id = d.subscription_id
      WHERE d.status = 'pending'
        AND d.next_attempt_at IS NOT NULL
        AND d.next_attempt_at <= now()
      ORDER BY d.created_at ASC
      LIMIT ${DELIVERY_BATCH}
      FOR UPDATE OF d SKIP LOCKED
    `);
    return (rows as unknown as Record<string, unknown>[]).map<PendingDeliveryRow>((r) => ({
      delivery: {
        id: r['d_id'] as string,
        subscriptionId: r['d_subscription_id'] as string,
        eventType: r['d_event_type'] as string,
        payload: r['d_payload'] as Record<string, unknown>,
        status: r['d_status'] as OutboundWebhookDelivery['status'],
        attempts: Number(r['d_attempts']),
        nextAttemptAt: r['d_next_attempt_at'] ? new Date(r['d_next_attempt_at'] as string) : null,
        deliveredAt: r['d_delivered_at'] ? new Date(r['d_delivered_at'] as string) : null,
        lastError: (r['d_last_error'] as string | null) ?? null,
        createdAt: new Date(r['d_created_at'] as string),
      },
      subscription: {
        id: r['s_id'] as string,
        tenantId: r['s_tenant_id'] as string,
        url: r['s_url'] as string,
        secret: r['s_secret'] as string,
        events: r['s_events'] as string[],
        status: r['s_status'] as WebhookSubscription['status'],
        createdAt: new Date(r['s_created_at'] as string),
      },
    }));
  });

  if (claimed.length === 0) return 0;

  await runWithConcurrency(claimed, Math.max(1, concurrency), processOne);
  return claimed.length;
}

export interface DeliveryListItem {
  id: string;
  eventType: string;
  status: OutboundWebhookDelivery['status'];
  attempts: number;
  lastError: string | null;
  nextAttemptAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
}

export interface DeliveryListPage {
  rows: DeliveryListItem[];
  nextCursor: string | null;
}

/**
 * Paged list of recent delivery attempts for a subscription — used by the
 * partner UI to debug delivery issues. Keyset on (createdAt, id) DESC.
 */
export async function listDeliveries(
  subscriptionId: string,
  tenantId: string,
  params: { limit?: number; cursor?: string } = {},
): Promise<DeliveryListPage> {
  const limit = Math.min(params.limit ?? 50, 100);
  // Cursor: `${createdAtIso}|${id}`
  let cursorTs: string | null = null;
  let cursorId: string | null = null;
  if (params.cursor) {
    const idx = params.cursor.lastIndexOf('|');
    if (idx > 0) {
      cursorTs = params.cursor.slice(0, idx);
      cursorId = params.cursor.slice(idx + 1);
    }
  }

  // Tenant guard: ensure the subscription belongs to this tenant before listing.
  const [sub] = await db
    .select()
    .from(webhookSubscriptions)
    .where(
      and(
        eq(webhookSubscriptions.id, subscriptionId),
        eq(webhookSubscriptions.tenantId, tenantId),
      ),
    )
    .limit(1);
  if (!sub) return { rows: [], nextCursor: null };

  const baseFilter = eq(outboundWebhookDeliveries.subscriptionId, subscriptionId);
  const cursorFilter = cursorTs && cursorId
    ? sql`(${outboundWebhookDeliveries.createdAt}, ${outboundWebhookDeliveries.id}) < (${cursorTs}::timestamptz, ${cursorId}::uuid)`
    : undefined;

  const rows = await db
    .select()
    .from(outboundWebhookDeliveries)
    .where(cursorFilter ? and(baseFilter, cursorFilter) : baseFilter)
    .orderBy(sql`${outboundWebhookDeliveries.createdAt} desc, ${outboundWebhookDeliveries.id} desc`)
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  const items: DeliveryListItem[] = pageRows.map((r) => ({
    id: r.id,
    eventType: r.eventType,
    status: r.status,
    attempts: r.attempts,
    lastError: r.lastError ?? null,
    nextAttemptAt: r.nextAttemptAt ? r.nextAttemptAt.toISOString() : null,
    deliveredAt: r.deliveredAt ? r.deliveredAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  }));

  let nextCursor: string | null = null;
  if (hasMore && pageRows.length > 0) {
    const last = pageRows[pageRows.length - 1]!;
    nextCursor = `${last.createdAt.toISOString()}|${last.id}`;
  }

  return { rows: items, nextCursor };
}
