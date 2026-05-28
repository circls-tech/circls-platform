import { jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { bigintPaise, createdAt, updatedAt, uuidPk } from './_columns.js';
import { bookings } from './bookings.js';
import { tenants } from './tenants.js';

/**
 * Payment ledger (Phase 12). Signed `amount_paise` so charges and refunds share
 * a row shape: positive = customer→venue, negative = refund. Idempotency on
 * `(provider, provider_payment_id)`.
 */
export const paymentProvider = pgEnum('payment_provider', ['razorpay', 'stub', 'external']);
export const paymentStatus = pgEnum('payment_status', [
  'pending',
  'authorized',
  'captured',
  'failed',
  'refunded',
  'partially_refunded',
]);
export const paymentKind = pgEnum('payment_kind', ['charge', 'refund', 'adjustment']);

export const payments = pgTable('payments', {
  id: uuidPk(),
  bookingId: uuid('booking_id')
    .notNull()
    .references(() => bookings.id),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  provider: paymentProvider('provider').notNull(),
  providerOrderId: text('provider_order_id'),
  providerPaymentId: text('provider_payment_id'),
  amountPaise: bigintPaise('amount_paise').notNull(),
  currency: text('currency').notNull().default('INR'),
  status: paymentStatus('status').notNull().default('pending'),
  kind: paymentKind('kind').notNull(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  // For charges: when funds become eligible to settle to the venue. Refunds
  // before this point claw back from the held pot.
  settlementHoldUntil: timestamp('settlement_hold_until', { withTimezone: true }),
  settlementReleasedAt: timestamp('settlement_released_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type Payment = typeof payments.$inferSelect;
export type NewPayment = typeof payments.$inferInsert;

/**
 * Settled payouts received from the provider (Razorpay Settlement). Populated
 * by the `payout_reconciliation` worker in Phase 14.
 */
export const payouts = pgTable('payouts', {
  id: uuidPk(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  provider: paymentProvider('provider').notNull(),
  providerPayoutId: text('provider_payout_id'),
  amountPaise: bigintPaise('amount_paise').notNull(),
  currency: text('currency').notNull().default('INR'),
  status: text('status').notNull(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  reconciledAt: timestamp('reconciled_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export type Payout = typeof payouts.$inferSelect;
export type NewPayout = typeof payouts.$inferInsert;
