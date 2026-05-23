import { jsonb, pgEnum, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, updatedAt, uuidPk } from './_columns.js';

/** The venue-owning business entity. Holds KYC, Razorpay, and subscription state. */
export const kycStatus = pgEnum('kyc_status', [
  'not_started',
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
  addressJson: jsonb('address_json'),
  kycStatus: kycStatus('kyc_status').notNull().default('not_started'),
  razorpayLinkedAccountId: text('razorpay_linked_account_id'),
  subscriptionStatus: subscriptionStatus('subscription_status').notNull().default('trial'),
  status: tenantStatus('status').notNull().default('active'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
