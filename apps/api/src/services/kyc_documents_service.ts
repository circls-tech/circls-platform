/**
 * KYC document service — Phase 11 (Track B).
 *
 * The Partner Portal uploads supporting documents via a presigned-URL flow:
 *
 *   1. POST /v1/tenants/:id/kyc/documents/presign
 *        Server creates a key under `kyc/{tenantId}/{docType}/{uuid}` and
 *        returns a presigned PUT URL.
 *   2. Client PUTs the file directly to that URL (stub mode: noop; R2 mode:
 *        real upload).
 *   3. POST /v1/tenants/:id/kyc/documents
 *        Client confirms the upload — server inserts the kyc_documents row.
 *   4. GET … /kyc/documents              → list rows.
 *   5. GET … /kyc/documents/:id/download → presigned GET URL.
 *
 * We deliberately do NOT trust the client to choose the storage key — we
 * mint it server-side so a misbehaving client can't collide with another
 * tenant's keys or escape the `kyc/{tenantId}/…` prefix.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { kycDocuments, type KycDocument } from '../db/schema/kyc_documents.js';
import { BadRequest, NotFound } from '../lib/errors.js';
import { getStorage, type PresignedUpload } from '../lib/storage.js';

/** The set of doc types the partner-portal form supports. Kept narrow so the
 *  R2 lifecycle policy stays simple. */
export const KYC_DOC_TYPES = [
  'pan',
  'gst',
  'bank_proof',
  'aadhaar_front',
  'aadhaar_back',
  'address',
  'other',
] as const;
export type KycDocType = (typeof KYC_DOC_TYPES)[number];

/** 10 MB. Anything larger is almost certainly a misuse — KYC pdfs are small. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const ALLOWED_MIME = new Set<string>([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

export interface PresignKycUploadInput {
  tenantId: string;
  docType: KycDocType;
  mimeType: string;
  /** Bytes the client wants to upload. Used for guardrail only — the R2
   *  presigned PUT will also enforce Content-Length. */
  sizeBytes: number;
}

export interface PresignKycUploadResult extends PresignedUpload {
  /** Echoed so the client can pass it back to `registerUploadedDocument`. */
  storageKey: string;
  docType: KycDocType;
  /** True when the storage backend is the in-memory stub (URL begins
   *  `stub://`). The UI uses this to surface a "not actually uploaded" hint. */
  stub: boolean;
}

export async function presignKycUpload(
  input: PresignKycUploadInput,
): Promise<PresignKycUploadResult> {
  if (!ALLOWED_MIME.has(input.mimeType)) {
    throw new BadRequest('Unsupported file type', 'unsupported_mime', {
      mimeType: input.mimeType,
      allowed: Array.from(ALLOWED_MIME),
    });
  }
  if (input.sizeBytes <= 0 || input.sizeBytes > MAX_UPLOAD_BYTES) {
    throw new BadRequest('File too large or empty', 'invalid_size', {
      sizeBytes: input.sizeBytes,
      maxBytes: MAX_UPLOAD_BYTES,
    });
  }

  const key = `kyc/${input.tenantId}/${input.docType}/${randomUUID()}`;
  const storage = getStorage();
  const presigned = await storage.presignUpload({
    key,
    contentType: input.mimeType,
  });

  return {
    ...presigned,
    docType: input.docType,
    stub: storage.mode === 'stub',
  };
}

export interface RegisterUploadedDocumentInput {
  tenantId: string;
  docType: KycDocType;
  /** Server-issued key from `presignKycUpload`. */
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
}

export async function registerUploadedDocument(
  input: RegisterUploadedDocumentInput,
): Promise<KycDocument> {
  // Defence-in-depth: the storage key must live under this tenant's prefix.
  // (Without this, a client could call /presign for tenant A, then claim that
  // key against tenant B via /documents.)
  const expectedPrefix = `kyc/${input.tenantId}/`;
  if (!input.storageKey.startsWith(expectedPrefix)) {
    throw new BadRequest('Storage key tenant prefix mismatch', 'storage_key_invalid');
  }
  const [row] = await db
    .insert(kycDocuments)
    .values({
      tenantId: input.tenantId,
      docType: input.docType,
      storageKey: input.storageKey,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
    })
    .returning();
  if (!row) throw new Error('kyc_documents insert returned no row');
  return row;
}

export async function listDocuments(tenantId: string): Promise<KycDocument[]> {
  return db
    .select()
    .from(kycDocuments)
    .where(eq(kycDocuments.tenantId, tenantId));
}

export interface KycDocumentDownload {
  document: KycDocument;
  url: string;
  stub: boolean;
  expiresIn: number;
}

export async function presignKycDocumentForReading(
  tenantId: string,
  documentId: string,
): Promise<KycDocumentDownload> {
  // Tenant-scoped lookup — a member of tenant A must not be able to download
  // tenant B's kyc files even if they guess the document id.
  const [doc] = await db
    .select()
    .from(kycDocuments)
    .where(and(eq(kycDocuments.id, documentId), eq(kycDocuments.tenantId, tenantId)))
    .limit(1);
  if (!doc) throw new NotFound('Document not found', 'kyc_document_not_found');

  const storage = getStorage();
  const expiresIn = 300; // 5 min
  const url = await storage.presignDownload(doc.storageKey, { expiresIn });
  return {
    document: doc,
    url,
    stub: storage.mode === 'stub',
    expiresIn,
  };
}
