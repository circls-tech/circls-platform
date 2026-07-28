import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { BadRequest, Forbidden } from '../lib/errors.js';
import { can } from '../lib/authz/can.js';
import { assertCap } from '../middleware/require_cap.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
import { requireTenantMembership } from '../middleware/tenant_context.js';
import {
  listMembers,
  removeMember,
  updateMemberProfile,
  updateMemberRole,
} from '../services/team_service.js';

const roleSchema = z.object({
  role: z.enum(['owner', 'manager', 'staff', 'readonly']),
});

const profileSchema = z
  .object({
    displayName: z.string().trim().min(1).max(120).nullable().optional(),
    phoneE164: z
      .string()
      .regex(/^\+[1-9]\d{6,14}$/, 'Must be E.164, e.g. +919876543210')
      .nullable()
      .optional(),
  })
  .refine((b) => b.displayName !== undefined || b.phoneE164 !== undefined, {
    message: 'Provide displayName and/or phoneE164',
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
      // Editing yourself needs no cap; editing others is owner/manager only.
      if (user.id !== targetUserId) assertCap(ctx, 'members.update');
      return updateMemberProfile({
        tenantId,
        targetUserId,
        actorUserId: user.id,
        ...(parsed.data.displayName !== undefined && { displayName: parsed.data.displayName }),
        ...(parsed.data.phoneE164 !== undefined && { phoneE164: parsed.data.phoneE164 }),
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
      if (user.id !== targetUserId) {
        if (!can(ctx, 'members.remove')) {
          throw new Forbidden('Missing capability members.remove', 'forbidden_capability', {
            cap: 'members.remove',
          });
        }
      }
      await removeMember({ tenantId, targetUserId, actorUserId: user.id });
      return reply.status(204).send();
    },
  );
};
