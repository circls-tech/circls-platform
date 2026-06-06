import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { env } from '../config/env.js';
import { BadRequest, Forbidden } from '../lib/errors.js';
import { assertCap } from '../middleware/require_cap.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
import { requireTenantMembership } from '../middleware/tenant_context.js';
import { verifyIdToken } from '../lib/firebase_admin.js';
import {
  acceptInvitation,
  createInvitation,
  listInvitations,
  lookupInvitation,
  resendInvitation,
  revokeInvitation,
} from '../services/invitation_service.js';

const inviteCreateSchema = z.object({
  email: z.string().email(),
  role: z.enum(['owner', 'manager', 'staff', 'readonly']),
});

export const invitationRoutes: FastifyPluginAsync = async (app) => {
  app.post('/v1/tenants/:tenantId/invitations', { preHandler: requireAuth }, async (req, reply) => {
    const { tenantId } = req.params as { tenantId: string };
    const parsed = inviteCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequest('Invalid invitation payload', 'bad_request', {
        issues: parsed.error.issues,
      });
    }
    const user = await currentUser(req);
    const ctx = await requireTenantMembership(user.id, tenantId);
    assertCap(ctx, 'members.invite');
    const result = await createInvitation({
      tenantId,
      actorUserId: user.id,
      email: parsed.data.email,
      role: parsed.data.role,
    });
    return reply.status(201).send({
      invitation: result.invitation,
      // Plaintext token is for dev preview only; never expose it in prod responses.
      ...(env.NODE_ENV !== 'production' ? { token: result.plaintextToken } : {}),
    });
  });

  const listQuerySchema = z.object({
    status: z.enum(['pending', 'accepted', 'expired', 'revoked']).optional(),
  });

  app.get(
    '/v1/tenants/:tenantId/invitations',
    { preHandler: requireAuth },
    async (req) => {
      const { tenantId } = req.params as { tenantId: string };
      const parsed = listQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new BadRequest('Invalid query', 'bad_request', { issues: parsed.error.issues });
      }
      const user = await currentUser(req);
      const ctx = await requireTenantMembership(user.id, tenantId);
      assertCap(ctx, 'members.read');
      return listInvitations(tenantId, parsed.data.status);
    },
  );

  app.post(
    '/v1/tenants/:tenantId/invitations/:invitationId/resend',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { tenantId, invitationId } = req.params as { tenantId: string; invitationId: string };
      const user = await currentUser(req);
      const ctx = await requireTenantMembership(user.id, tenantId);
      assertCap(ctx, 'members.invite');
      const result = await resendInvitation({ tenantId, invitationId, actorUserId: user.id });
      return reply.status(200).send({
        invitation: result.invitation,
        // Plaintext token is for dev preview only; never expose it in prod responses.
        ...(env.NODE_ENV !== 'production' ? { token: result.plaintextToken } : {}),
      });
    },
  );

  app.delete(
    '/v1/tenants/:tenantId/invitations/:invitationId',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { tenantId, invitationId } = req.params as { tenantId: string; invitationId: string };
      const user = await currentUser(req);
      const ctx = await requireTenantMembership(user.id, tenantId);
      assertCap(ctx, 'members.invite');
      await revokeInvitation({ tenantId, invitationId, actorUserId: user.id });
      return reply.status(204).send();
    },
  );

  // Unauthenticated peek for the accept page.
  app.get('/v1/invitations/lookup', async (req) => {
    const token = (req.query as { token?: string }).token;
    if (!token) throw new BadRequest('Missing token', 'missing_token');
    const meta = await lookupInvitation(token);
    if (!meta) throw new BadRequest('Invitation not found', 'invitation_not_found');
    return {
      tenantName: meta.tenantName,
      role: meta.role,
      email: meta.email,
      inviterEmail: meta.inviterEmail,
      expiresAt: meta.expiresAt,
    };
  });

  // Unauthenticated accept. Body carries the Firebase ID token of the
  // accepting user (newly signed up); we verify it here.
  const acceptSchema = z.object({ firebaseIdToken: z.string().min(1) });
  app.post('/v1/invitations/:token/accept', async (req, reply) => {
    const { token } = req.params as { token: string };
    const parsed = acceptSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequest('Invalid accept payload', 'bad_request', {
        issues: parsed.error.issues,
      });
    }
    const decoded = await verifyIdToken(parsed.data.firebaseIdToken);
    if (!decoded.email) {
      throw new Forbidden('Firebase token has no email', 'no_email_claim');
    }
    if (!decoded.email_verified) {
      throw new Forbidden('Email not verified', 'email_unverified');
    }
    const result = await acceptInvitation({
      token,
      firebaseUid: decoded.uid,
      email: decoded.email,
    });
    return reply.status(201).send(result);
  });
};
