import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { payments } from '../db/schema/index.js';
import { can } from '../lib/authz/can.js';
import { getPlatformTenantId } from '../lib/authz/platform_tenant.js';
import { BadRequest, Forbidden, NotFound } from '../lib/errors.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
import { requireTenantMembership } from '../middleware/tenant_context.js';
import { issueRefund } from '../services/refund_service.js';

const refundBodySchema = z.object({
  amountPaise: z.number().int().positive(),
  reason: z.string().min(1).max(500),
});

/**
 * POST /v1/admin/payments/:paymentId/refund
 *
 * Manual, out-of-policy refunds — used when the standard cancellation tiers
 * don't fit (goodwill, billing dispute, partial-service complaint). Bypasses
 * `computeRefundPolicy()` entirely; `issueRefund()` still validates that the
 * requested amount doesn't exceed the remaining-to-refund balance.
 *
 * Authorisation (capability-based):
 *   1. Platform admin with `admin.payouts.execute` (owner/manager of the Circls
 *      platform tenant), OR
 *   2. An 'owner' of the tenant the payment belongs to (self-service refund).
 *
 * `bySelf=false` audit semantics apply implicitly: this is always a staff
 * override.
 */
export const adminRefundRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/v1/admin/payments/:paymentId/refund',
    { preHandler: requireAuth },
    async (req) => {
      const { paymentId } = req.params as { paymentId: string };
      const parsed = refundBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new BadRequest('Invalid refund payload', 'bad_request', {
          issues: parsed.error.issues,
        });
      }

      const [payment] = await db
        .select()
        .from(payments)
        .where(eq(payments.id, paymentId))
        .limit(1);
      if (!payment) throw new NotFound('Payment not found', 'payment_not_found');
      if (payment.kind !== 'charge') {
        throw new BadRequest('Can only refund a charge row', 'not_a_charge');
      }

      const user = await currentUser(req);

      // 1. Platform admin with refund/payout power?
      let allowed = false;
      const platformTenantId = await getPlatformTenantId();
      try {
        const platformCtx = await requireTenantMembership(user.id, platformTenantId);
        allowed = can(platformCtx, 'admin.payouts.execute');
      } catch {
        // Not a member of the platform tenant — fall through to the owner check.
      }
      // 2. Otherwise, an owner of the payment's own tenant.
      if (!allowed) {
        try {
          const tenantCtx = await requireTenantMembership(user.id, payment.tenantId);
          allowed = tenantCtx.role === 'owner';
        } catch {
          // Not a member of the payment's tenant either.
        }
      }
      if (!allowed) {
        throw new Forbidden('Admin refund requires platform-admin or tenant-owner', 'admin_required');
      }

      return issueRefund({
        bookingId: payment.bookingId,
        amountPaise: parsed.data.amountPaise,
        reason: parsed.data.reason,
        actorUserId: user.id,
      });
    },
  );
};
