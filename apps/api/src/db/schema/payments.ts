import { jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { bigintPaise, createdAt, updatedAt, uuidPk } from './_columns.js';
import { bookings } from './bookings.js';
import { tenants } from './tenants.js';
import { users } from './users.js';

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
 * Weekly payouts owed to each venue. Circls is the merchant, so this is NOT a
 * Razorpay settlement mirror — it's what Circls owes the venue for a settlement
 * week, computed as gross captured charges − refunds − commission. The
 * `payout_reconciliation` worker inserts one `pending` row per tenant per week;
 * platform ops then transfers the money out-of-band and marks it `paid` with a
 * bank reference (no bank details are stored in-app).
 *
 * Idempotent per (tenant, period): a re-run of the weekly job is a no-op.
 */
export const payouts = pgTable(
  'payouts',
  {
    id: uuidPk(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    provider: paymentProvider('provider').notNull(),
    providerPayoutId: text('provider_payout_id'),
    /** Settlement week the payout covers: [periodStart, periodEnd). */
    periodStart: timestamp('period_start', { withTimezone: true }),
    periodEnd: timestamp('period_end', { withTimezone: true }),
    /** Breakdown in paise. net (amountPaise) = gross − refunds − commission. */
    grossPaise: bigintPaise('gross_paise').notNull().default(0),
    refundsPaise: bigintPaise('refunds_paise').notNull().default(0),
    commissionPaise: bigintPaise('commission_paise').notNull().default(0),
    /** Net payable to the venue, in paise. */
    amountPaise: bigintPaise('amount_paise').notNull(),
    currency: text('currency').notNull().default('INR'),
    /** 'pending' (awaiting ops execution) → 'paid'. */
    status: text('status').notNull().default('pending'),
    /** Execution record — set when ops marks the out-of-band transfer done. */
    paidAt: timestamp('paid_at', { withTimezone: true }),
    paidReference: text('paid_reference'),
    paidByUserId: uuid('paid_by_user_id').references(() => users.id),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    reconciledAt: timestamp('reconciled_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => ({
    tenantPeriodUniq: uniqueIndex('payouts_tenant_period_uniq').on(
      t.tenantId,
      t.periodStart,
      t.periodEnd,
    ),
  }),
);

export type Payout = typeof payouts.$inferSelect;
export type NewPayout = typeof payouts.$inferInsert;
