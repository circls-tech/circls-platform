import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { BadRequest } from '../lib/errors.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
import { requireTenantMembership } from '../middleware/tenant_context.js';
import { getKycStatus, submitKyc } from '../services/kyc_service.js';

/**
 * KYC routes — Phase 11. Stubs return 501 for the write paths until the
 * subagent fills in submitKyc(); the read path (`GET …/kyc`) is real because
 * the tenant column is already populated by Track A.
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

export const kycRoutes: FastifyPluginAsync = async (app) => {
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
};
