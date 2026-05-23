import type { FastifyPluginAsync } from 'fastify';
import { requireAuth } from '../middleware/require_auth.js';
import { findOrCreateByFirebaseUid } from '../services/user_service.js';

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
};
