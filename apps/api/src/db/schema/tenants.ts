import { boolean, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
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
  // ── Partner Terms & Conditions acceptance ───────────────────────────────────
  // One acceptance covers the whole org. `termsRegion` records which regional
  // document ('US' | 'IN') was accepted; `termsVersion` which revision. A null
  // `termsAcceptedAt` (or a stale version) blocks creating venues/events/
  // memberships until an owner/manager re-accepts.
  termsVersion: text('terms_version'),
  termsRegion: text('terms_region').$type<'US' | 'IN'>(),
  termsAcceptedAt: timestamp('terms_accepted_at', { withTimezone: true }),
  termsAcceptedByUserId: uuid('terms_accepted_by_user_id'),
  /** Per-tenant partner-side commission Circls keeps, in basis points
   *  (100 bps = 1%). Snapshotted per charge into
   *  payments.partner_commission_paise; events may override via
   *  events.partner_commission_bps. Legacy charges (NULL snapshot) fall back
   *  to this rate at payout reconciliation. */
  commissionBps: integer('commission_bps').notNull().default(0),
  // ── Billing knobs (admin-editable; defaults preserve legacy behaviour) ─────
  /** Consumer-side commission charged ON TOP of the customer's total, in bps
   *  of the discounted base. Folded into "Other charges" at checkout; never
   *  part of the org's settle base. Events may override. */
  consumerCommissionBps: integer('consumer_commission_bps').notNull().default(0),
  /** Share of the gateway fee the customer pays via the checkout gross-up,
   *  in bps. 10000 = customer pays all (legacy). */
  customerFeeShareBps: integer('customer_fee_share_bps').notNull().default(10000),
  /** Share of the gateway fee the org bears, deducted from the charge's
   *  settle base. customer + org ≤ 10000; Circls absorbs the remainder. */
  orgFeeShareBps: integer('org_fee_share_bps').notNull().default(0),
  /** Share of each charge's net payout (settle base − partner commission)
   *  paid out in the weekly payout after CAPTURE instead of waiting for the
   *  settlement hold. The final tranche nets it back out. Events may override. */
  advancePayoutBps: integer('advance_payout_bps').notNull().default(0),
  subscriptionStatus: subscriptionStatus('subscription_status').notNull().default('trial'),
  status: tenantStatus('status').notNull().default('active'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
