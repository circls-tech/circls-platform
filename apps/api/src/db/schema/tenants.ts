import { boolean, jsonb, pgEnum, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { createdAt, updatedAt, uuidPk } from './_columns.js';

/** The venue-owning business entity. Holds KYC, Razorpay, and subscription state. */
export const kycStatus = pgEnum('kyc_status', [
  'not_started',
  'submitted',
  'in_review',
  'verified',
  'rejected',
]);
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
  legalEntityName: text('legal_entity_name'),
  gstin: text('gstin'),
  panNumber: text('pan_number'),
  bankAccountNumber: text('bank_account_number'),
  bankIfsc: text('bank_ifsc'),
  bankAccountHolderName: text('bank_account_holder_name'),
  addressJson: jsonb('address_json'),
  /** Belt-and-suspenders next to the reserved slug. The Circls internal
   *  tenant sets this true; authz reads this, not the slug. */
  isPlatform: boolean('is_platform').notNull().default(false),
  kycStatus: kycStatus('kyc_status').notNull().default('not_started'),
  kycSubmittedAt: timestamp('kyc_submitted_at', { withTimezone: true }),
  kycVerifiedAt: timestamp('kyc_verified_at', { withTimezone: true }),
  kycRejectionReason: text('kyc_rejection_reason'),
  razorpayLinkedAccountId: text('razorpay_linked_account_id'),
  subscriptionStatus: subscriptionStatus('subscription_status').notNull().default('trial'),
  status: tenantStatus('status').notNull().default('active'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
