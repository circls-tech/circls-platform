import type { FastifyReply, FastifyRequest } from 'fastify';
import { Forbidden, Unauthorized } from '../lib/errors.js';

/**
 * Requires the `admin` Firebase custom claim. Use after requireAuth:
 *   { preHandler: [requireAuth, requireAdmin] }
 */
export async function requireAdmin(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!req.authUser) throw new Unauthorized();
  if (req.authUser.claims.admin !== true) {
    throw new Forbidden('Admin access required', 'admin_required');
  }
}
