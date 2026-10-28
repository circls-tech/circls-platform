import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { BadRequest, NotFound } from '../lib/errors.js';
import { assertCap } from '../middleware/require_cap.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
import { requireTenantMembership } from '../middleware/tenant_context.js';
import {
  listMembers,
  removeMember,
  setMemberSuperAdmin,
  updateMemberProfile,
  updateMemberRole,
} from '../services/team_service.js';

const roleSchema = z.object({
  role: z.enum(['owner', 'manager', 'staff', 'readonly']),
});

// Name only. Phone is deliberately NOT editable here: users.phone_e164 is an
// identity key (adoptStaleIdentity) and its only writers are OTP-verified
// Firebase logins — an owner-typed number would be an unproven claim.
const superAdminSchema = z.object({ superAdmin: z.boolean() });

const profileSchema = z.object({
  displayName: z.string().trim().min(1).max(120).nullable(),
});

export const teamRoutes: FastifyPluginAsync = async (app) => {
  app.get('/v1/tenants/:tenantId/members', { preHandler: requireAuth }, async (req) => {
    const { tenantId } = req.params as { tenantId: string };
    const user = await currentUser(req);
    const ctx = await requireTenantMembership(user.id, tenantId);
    assertCap(ctx, 'members.read');
    return listMembers(tenantId);
  });

  app.patch(
    '/v1/tenants/:tenantId/members/:userId',
    { preHandler: requireAuth },
    async (req) => {
      const { tenantId, userId: targetUserId } = req.params as {
        tenantId: string;
        userId: string;
      };
      const parsed = roleSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new BadRequest('Invalid role payload', 'bad_request', {
          issues: parsed.error.issues,
        });
      }
      const user = await currentUser(req);
      const ctx = await requireTenantMembership(user.id, tenantId);
      assertCap(ctx, 'members.role_change');
      return updateMemberRole({
        tenantId,
        targetUserId,
        actorUserId: user.id,
        actorRole: ctx.role,
        nextRole: parsed.data.role,
      });
    },
  );

  app.patch(
    '/v1/tenants/:tenantId/members/:userId/profile',
    { preHandler: requireAuth },
    async (req) => {
      const { tenantId, userId: targetUserId } = req.params as {
        tenantId: string;
        userId: string;
      };
      const parsed = profileSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new BadRequest('Invalid profile payload', 'bad_request', {
          issues: parsed.error.issues,
        });
      }
      const user = await currentUser(req);
      const ctx = await requireTenantMembership(user.id, tenantId);
      // Editing yourself needs no cap; editing others is owner/manager only
      // (and never someone above you — the service checks that).
      if (user.id !== targetUserId) assertCap(ctx, 'members.update');
      return updateMemberProfile({
        tenantId,
        targetUserId,
        actorUserId: user.id,
        actorRole: ctx.role,
        displayName: parsed.data.displayName,
      });
    },
  );

  // Circls team only: the super-admin switch (open partner orgs that ask
  // Circls for help). Platform Owners only — it rides members.role_change, which on the
  // Circls tenant only Owners hold.
  app.patch(
    '/v1/tenants/:tenantId/members/:userId/super-admin',
    { preHandler: requireAuth },
    async (req) => {
      const { tenantId, userId: targetUserId } = req.params as {
        tenantId: string;
        userId: string;
      };
      const parsed = superAdminSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new BadRequest('Invalid super admin payload', 'bad_request', {
          issues: parsed.error.issues,
        });
      }
      const user = await currentUser(req);
      const ctx = await requireTenantMembership(user.id, tenantId);
      if (!ctx.isPlatform) {
        throw new NotFound('Super admins are set on the Circls team only', 'not_platform_tenant');
      }
      assertCap(ctx, 'members.role_change');
      return setMemberSuperAdmin({
        tenantId,
        targetUserId,
        actorUserId: user.id,
        superAdmin: parsed.data.superAdmin,
      });
    },
  );

  app.delete(
    '/v1/tenants/:tenantId/members/:userId',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { tenantId, userId: targetUserId } = req.params as {
        tenantId: string;
        userId: string;
      };
      const user = await currentUser(req);
      const ctx = await requireTenantMembership(user.id, tenantId);
      // Self-remove bypasses the cap.
      if (user.id !== targetUserId) assertCap(ctx, 'members.remove');
      await removeMember({ tenantId, targetUserId, actorUserId: user.id, actorRole: ctx.role });
      return reply.status(204).send();
    },
  );
};
