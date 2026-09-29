import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getPlatformTenantId } from '../lib/authz/platform_tenant.js';
import { writeAudit } from '../lib/audit.js';
import { db } from '../db/client.js';
import { BadRequest } from '../lib/errors.js';
import { clearCashfreeFailover } from '../lib/inr_failover.js';
import { assertCap } from '../middleware/require_cap.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
import { requireTenantMembership } from '../middleware/tenant_context.js';
import { getPaymentSettings, setInrPaymentGateway } from '../services/payment_settings_service.js';

const updateBody = z.object({ inrGateway: z.enum(['razorpay', 'cashfree']) });

/**
 * Platform-admin payment settings (admin portal → Payments): which gateway new
 * INR orders go to — the manual Cashfree/Razorpay switch — plus the state of
 * the automatic failover. Money-movement settings, so the same capabilities as
 * payouts: read on `admin.payouts.read`, change on `admin.payouts.execute`.
 */
export const adminPaymentSettingsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/v1/admin/payment-settings', { preHandler: requireAuth }, async (req) => {
    const user = await currentUser(req);
    const ctx = await requireTenantMembership(user.id, await getPlatformTenantId());
    assertCap(ctx, 'admin.payouts.read');
    return getPaymentSettings();
  });

  app.put('/v1/admin/payment-settings', { preHandler: requireAuth }, async (req) => {
    const user = await currentUser(req);
    const ctx = await requireTenantMembership(user.id, await getPlatformTenantId());
    assertCap(ctx, 'admin.payouts.execute');
    const parsed = updateBody.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequest('Invalid payment settings', 'bad_request', {
        issues: parsed.error.issues,
      });
    }
    return setInrPaymentGateway(parsed.data.inrGateway, user.id);
  });

  // End an automatic failover early: the next INR order tries Cashfree again.
  app.post('/v1/admin/payment-settings/failover/clear', { preHandler: requireAuth }, async (req) => {
    const user = await currentUser(req);
    const platformTenantId = await getPlatformTenantId();
    const ctx = await requireTenantMembership(user.id, platformTenantId);
    assertCap(ctx, 'admin.payouts.execute');
    clearCashfreeFailover();
    await writeAudit(
      db,
      { tenantId: platformTenantId, actorUserId: user.id },
      'platform.inr_failover_cleared',
      'platform',
      platformTenantId,
      null,
      null,
    );
    return getPaymentSettings();
  });
};
