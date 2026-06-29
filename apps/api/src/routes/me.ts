import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/require_auth.js';
import { currentUser } from '../middleware/current_user.js';
import { findOrCreateByFirebaseUid } from '../services/user_service.js';
import { LOGIN_SOURCES, recordLogin } from '../services/login_service.js';

const loginBodySchema = z.object({
  source: z.enum(LOGIN_SOURCES).optional(),
});

export const meRoutes: FastifyPluginAsync = async (app) => {
  app.get('/v1/me', { preHandler: requireAuth }, async (req) => {
    // requireAuth guarantees authUser is set, or it would have thrown.
    const auth = req.authUser!;
    return findOrCreateByFirebaseUid({
      firebaseUid: auth.firebaseUid,
      phoneE164: auth.phoneE164,
      email: auth.email,
    });
  });

  // Records one login_events row per fresh sign-in. The frontends call this once
  // after a successful credential exchange (not on session restore), so the row
  // count reflects real logins. Returns 204; auditing must never block sign-in.
  app.post('/v1/me/login', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = loginBodySchema.safeParse(req.body ?? {});
    const source = parsed.success ? (parsed.data.source ?? null) : null;
    const user = await currentUser(req);
    await recordLogin(user.id, source);
    return reply.status(204).send();
  });
};
