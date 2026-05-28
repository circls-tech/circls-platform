/**
 * Payments service stub — Phase 12 owner fills these in.
 *
 * Contract surfaces:
 *   - createRouteOrder(): called by POST /v1/bookings when paymentMethod='razorpay_route'.
 *   - handleRazorpayWebhook(): called by POST /webhooks/razorpay (signature verified before).
 *   - listForBooking(): read endpoint used by partner + admin UIs.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { payments, type Payment } from '../db/schema/payments.js';

export interface CreateRouteOrderInput {
  bookingId: string;
  tenantId: string;
  amountPaise: number;
  /** Razorpay Linked Account on the tenant. */
  linkedAccountId: string;
  /** Platform commission in paise. */
  platformFeePaise: number;
}

export interface CreateRouteOrderResult {
  paymentId: string;
  providerOrderId: string;
}

export async function createRouteOrder(
  _input: CreateRouteOrderInput,
): Promise<CreateRouteOrderResult> {
  throw new Error('payments_service.createRouteOrder not implemented — phase 12');
}

export interface WebhookEvent {
  event: string;
  payload: Record<string, unknown>;
  /** Idempotency key from the webhook header (Razorpay's `x-razorpay-event-id`). */
  eventId: string;
}

export async function handleRazorpayWebhook(_event: WebhookEvent): Promise<void> {
  throw new Error('payments_service.handleRazorpayWebhook not implemented — phase 12');
}

export async function listForBooking(bookingId: string): Promise<Payment[]> {
  return db.select().from(payments).where(eq(payments.bookingId, bookingId));
}

export async function getPayment(
  paymentId: string,
  tenantId: string,
): Promise<Payment | null> {
  const [row] = await db
    .select()
    .from(payments)
    .where(and(eq(payments.id, paymentId), eq(payments.tenantId, tenantId)))
    .limit(1);
  return row ?? null;
}
