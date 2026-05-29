import { boolean, integer, jsonb, pgEnum, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { createdAt, updatedAt, uuidPk } from './_columns.js';

/**
 * The venue-owning business entity. Holds subscription + commission state.
 *
 * Circls is the payment merchant: there are no per-tenant Razorpay Linked
 * Accounts or KYC. Payments land in Circls's account; venues are paid out
 * out-of-band on a weekly schedule, net of a per-tenant commission.
 */
export const subscriptionStatus = pgEnum('subscription_status', [
  'trial',
  'active',
  'suspended',
  'cancelled',
]);
export const tenantStatus = pgEnum('tenant_status', ['active', 'suspended']);

export const tenants = pgTable('tenants', {
  id: uuidPk(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  addressJson: jsonb('address_json'),
  /** Belt-and-suspenders next to the reserved slug. The Circls internal
   *  tenant sets this true; authz reads this, not the slug. */
  isPlatform: boolean('is_platform').notNull().default(false),
  /** Per-tenant commission Circls keeps, in basis points (100 bps = 1%).
   *  Applied at payout time: net = gross − refunds − commission. */
  commissionBps: integer('commission_bps').notNull().default(0),
  subscriptionStatus: subscriptionStatus('subscription_status').notNull().default('trial'),
  status: tenantStatus('status').notNull().default('active'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
