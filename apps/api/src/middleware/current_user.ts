import type { FastifyRequest } from 'fastify';
import type { User } from '../db/schema/index.js';
import { Unauthorized } from '../lib/errors.js';
import { findOrCreateByFirebaseUid } from '../services/user_service.js';

/** Resolve req.authUser (Firebase identity) to our User row, creating on first sight. */
export async function currentUser(req: FastifyRequest): Promise<User> {
  if (!req.authUser) throw new Unauthorized();
  return findOrCreateByFirebaseUid({
    firebaseUid: req.authUser.firebaseUid,
    phoneE164: req.authUser.phoneE164,
    email: req.authUser.email,
  });
}
