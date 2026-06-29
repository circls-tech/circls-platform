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

/**
 * Social handles/URLs an org can advertise. All optional; stored as a single
 * jsonb blob so adding a platform never needs a migration.
 */
export interface TenantSocials {
  instagram?: string;
  facebook?: string;
  x?: string;
  youtube?: string;
}

export const tenants = pgTable('tenants', {
  id: uuidPk(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  /** Legacy unstructured address. Kept for back-compat; new editors write the
   *  structured `address*` columns below. */
  addressJson: jsonb('address_json'),
  // ── Org/brand profile (PR #107). All nullable; self-edited by owner/manager
  //    via PATCH /v1/tenants/:id and surfaced to consumers (PR #108).
  description: text('description'),
  contactEmail: text('contact_email'),
  contactPhone: text('contact_phone'),
  websiteUrl: text('website_url'),
  socials: jsonb('socials').$type<TenantSocials>(),
  /** Structured postal address (supersedes the unstructured address_json). */
  addressLine1: text('address_line1'),
  addressLine2: text('address_line2'),
  city: text('city'),
  state: text('state'),
  postalCode: text('postal_code'),
  country: text('country'),
  /** R2 object key of the org logo (single image). Public URL is derived at the
   *  service layer; finalized via a presign+HEAD step like venue images. */
  logoStorageKey: text('logo_storage_key'),
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
