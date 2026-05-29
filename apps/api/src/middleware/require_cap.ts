import { Forbidden } from '../lib/errors.js';
import { can } from '../lib/authz/can.js';
import type { Capability } from '../lib/authz/capabilities.js';
import type { TenantContext } from './tenant_context.js';

/**
 * Sync capability check used inside route handlers after the caller has
 * already resolved `ctx` via `requireTenantMembership`. Throws Forbidden
 * with code='forbidden_capability' and a `{cap}` detail.
 *
 * Why not a Fastify preHandler? Most routes need the tenantId from a path
 * param resolved + ownership checks before they know the cap to check (e.g.,
 * GET /v1/venues/:id authz needs the venue's tenantId). assertCap stays
 * synchronous so handlers can call it inline after their lookup.
 */
export function assertCap(ctx: TenantContext, cap: Capability): void {
  if (!can(ctx, cap)) {
    throw new Forbidden(`Missing capability ${cap}`, 'forbidden_capability', { cap });
  }
}
