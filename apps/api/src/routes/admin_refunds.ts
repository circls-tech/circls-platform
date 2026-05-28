import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { payments, tenantMembers } from '../db/schema/index.js';
import { env } from '../config/env.js';
import { BadRequest, Forbidden, NotFound } from '../lib/errors.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
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
 * Authorisation, until Phase 16 lands proper RBAC:
 *   1. User id is in env.ADMIN_USER_IDS  (platform-staff backdoor), OR
 *   2. User is an 'owner' of the tenant the payment belongs to.
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

      const isPlatformAdmin = env.ADMIN_USER_IDS.includes(user.id);
      let isTenantOwner = false;
      if (!isPlatformAdmin) {
        const [member] = await db
          .select()
          .from(tenantMembers)
          .where(
            and(
              eq(tenantMembers.userId, user.id),
              eq(tenantMembers.tenantId, payment.tenantId),
              eq(tenantMembers.role, 'owner'),
            ),
          )
          .limit(1);
        isTenantOwner = Boolean(member);
      }
      if (!isPlatformAdmin && !isTenantOwner) {
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
