import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { BadRequest } from '../lib/errors.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
import { requireTenantMembership } from '../middleware/tenant_context.js';
import { getKycStatus, submitKyc } from '../services/kyc_service.js';
import {
  KYC_DOC_TYPES,
  listDocuments,
  presignKycDocumentForReading,
  presignKycUpload,
  registerUploadedDocument,
} from '../services/kyc_documents_service.js';

/**
 * KYC routes — Phase 11.
 *
 *   GET    /v1/tenants/:tenantId/kyc                       — read current state.
 *   POST   /v1/tenants/:tenantId/kyc                       — submit KYC bundle.
 *   POST   /v1/tenants/:tenantId/kyc/documents/presign     — get a presigned PUT.
 *   POST   /v1/tenants/:tenantId/kyc/documents             — register an uploaded doc.
 *   GET    /v1/tenants/:tenantId/kyc/documents             — list docs.
 *   GET    /v1/tenants/:tenantId/kyc/documents/:id/download — presigned GET URL.
 *
 * Every route asserts tenant-membership via `requireTenantMembership`.
 */
const submitKycSchema = z.object({
  legalName: z.string().min(1).max(200),
  email: z.string().email(),
  phone: z.string().optional(),
  pan: z.string().regex(/^[A-Z]{5}\d{4}[A-Z]$/i).optional(),
  gstin: z.string().min(15).max(15).optional(),
  bank: z
    .object({
      accountNumber: z.string().min(6).max(20),
      ifsc: z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/i),
      holderName: z.string().min(1).max(200),
    })
    .optional(),
});

const presignSchema = z.object({
  docType: z.enum(KYC_DOC_TYPES),
  mimeType: z.string().min(1).max(100),
  sizeBytes: z.number().int().positive(),
});

const registerDocSchema = z.object({
  docType: z.enum(KYC_DOC_TYPES),
  storageKey: z.string().min(1).max(500),
  mimeType: z.string().min(1).max(100),
  sizeBytes: z.number().int().positive(),
});

export const kycRoutes: FastifyPluginAsync = async (app) => {
  // ── KYC bundle ────────────────────────────────────────────────────────────
  app.get(
    '/v1/tenants/:tenantId/kyc',
    { preHandler: requireAuth },
    async (req) => {
      const { tenantId } = req.params as { tenantId: string };
      const user = await currentUser(req);
      await requireTenantMembership(user.id, tenantId);
      return getKycStatus(tenantId);
    },
  );

  app.post(
    '/v1/tenants/:tenantId/kyc',
    { preHandler: requireAuth },
    async (req) => {
      const { tenantId } = req.params as { tenantId: string };
      const parsed = submitKycSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new BadRequest('Invalid KYC payload', 'bad_request', {
          issues: parsed.error.issues,
        });
      }
      const user = await currentUser(req);
      await requireTenantMembership(user.id, tenantId);
      return submitKyc(tenantId, user.id, parsed.data);
    },
  );

  // ── Documents ─────────────────────────────────────────────────────────────
  app.post(
    '/v1/tenants/:tenantId/kyc/documents/presign',
    { preHandler: requireAuth },
    async (req) => {
      const { tenantId } = req.params as { tenantId: string };
      const parsed = presignSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new BadRequest('Invalid presign payload', 'bad_request', {
          issues: parsed.error.issues,
        });
      }
      const user = await currentUser(req);
      await requireTenantMembership(user.id, tenantId);
      return presignKycUpload({
        tenantId,
        docType: parsed.data.docType,
        mimeType: parsed.data.mimeType,
        sizeBytes: parsed.data.sizeBytes,
      });
    },
  );

  app.post(
    '/v1/tenants/:tenantId/kyc/documents',
    { preHandler: requireAuth },
    async (req) => {
      const { tenantId } = req.params as { tenantId: string };
      const parsed = registerDocSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new BadRequest('Invalid document payload', 'bad_request', {
          issues: parsed.error.issues,
        });
      }
      const user = await currentUser(req);
      await requireTenantMembership(user.id, tenantId);
      return registerUploadedDocument({
        tenantId,
        docType: parsed.data.docType,
        storageKey: parsed.data.storageKey,
        mimeType: parsed.data.mimeType,
        sizeBytes: parsed.data.sizeBytes,
      });
    },
  );

  app.get(
    '/v1/tenants/:tenantId/kyc/documents',
    { preHandler: requireAuth },
    async (req) => {
      const { tenantId } = req.params as { tenantId: string };
      const user = await currentUser(req);
      await requireTenantMembership(user.id, tenantId);
      return listDocuments(tenantId);
    },
  );

  app.get(
    '/v1/tenants/:tenantId/kyc/documents/:id/download',
    { preHandler: requireAuth },
    async (req) => {
      const { tenantId, id } = req.params as { tenantId: string; id: string };
      const user = await currentUser(req);
      await requireTenantMembership(user.id, tenantId);
      return presignKycDocumentForReading(tenantId, id);
    },
  );
};
