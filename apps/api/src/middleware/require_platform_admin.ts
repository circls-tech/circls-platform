import type { FastifyRequest } from 'fastify';
import { env } from '../config/env.js';
import { Forbidden, Unauthorized } from '../lib/errors.js';
import { currentUser } from './current_user.js';

/**
 * Gate /v1/admin/** endpoints. Resolves req.authUser → our users row and checks
 * that user.id is in the PLATFORM_ADMIN_USER_IDS allowlist.
 *
 * Use after requireAuth:
 *   { preHandler: [requireAuth, requirePlatformAdmin] }
 *
 * Side effect: attaches the resolved User row to req.platformAdmin so handlers
 * don't have to call currentUser() a second time.
 */
declare module 'fastify' {
  interface FastifyRequest {
    platformAdmin?: { userId: string };
  }
}

/**
 * Read the allowlist fresh on every call. `env.PLATFORM_ADMIN_USER_IDS` is the
 * snapshot at module-load, but process.env can be mutated by tests after import
 * — we honour the live value so tests can flip allowlist state per-case.
 */
function platformAdminAllowlist(): readonly string[] {
  const live = process.env['PLATFORM_ADMIN_USER_IDS'];
  if (live !== undefined) {
    return live
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return env.PLATFORM_ADMIN_USER_IDS;
}

export async function requirePlatformAdmin(req: FastifyRequest): Promise<void> {
  if (!req.authUser) throw new Unauthorized();
  const user = await currentUser(req);
  if (!platformAdminAllowlist().includes(user.id)) {
    throw new Forbidden('platform_admin_required', 'platform_admin_required');
  }
  req.platformAdmin = { userId: user.id };
}
