import { bigint, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, uuidPk } from './_columns.js';
import { tenants } from './tenants.js';

/**
 * One row per file a Tenant uploaded for KYC. Storage object lives in R2 (or
 * the stub in-memory adapter in dev); `storage_key` is the bucket key.
 *
 * Phase 11 (Track B).
 */
export const kycDocuments = pgTable('kyc_documents', {
  id: uuidPk(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  // 'pan' | 'gst' | 'bank_proof' | 'aadhaar_front' | 'aadhaar_back' | 'address' | 'other'
  docType: text('doc_type').notNull(),
  storageKey: text('storage_key').notNull(),
  mimeType: text('mime_type'),
  sizeBytes: bigint('size_bytes', { mode: 'number' }),
  uploadedAt: createdAt(),
});

export type KycDocument = typeof kycDocuments.$inferSelect;
export type NewKycDocument = typeof kycDocuments.$inferInsert;
