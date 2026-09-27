import { ROLE_RANK, type TenantRole } from '../../db/schema/tenant_members.js';
import { Forbidden } from '../errors.js';
import type { Capability } from './capabilities.js';
import { PARTNER_CAPS, PLATFORM_CAPS } from './role_caps.js';

export interface AuthzContext {
  role: TenantRole;
  isPlatform: boolean;
  /**
   * A suspended tenant keeps its read capabilities and loses the rest.
   * Required, so a context built by hand has to decide it (see isSuspendedTenant).
   */
  suspended: boolean;
}

/** Circls suspended this partner tenant (the platform tenant is never suspended). */
export function isSuspendedTenant(tenant: { isPlatform: boolean; status: string }): boolean {
  return !tenant.isPlatform && tenant.status === 'suspended';
}

/** The refusal every change to a suspended organisation gets (code tenant_suspended). */
export function tenantSuspendedError(cap?: Capability): Forbidden {
  return new Forbidden(
    'This organisation is suspended, so it can be viewed but not changed. Contact Circls.',
    'tenant_suspended',
    cap ? { cap } : undefined,
  );
}

/** The capabilities that only read: all a suspended tenant keeps. */
export function isReadCapability(cap: Capability): boolean {
  return cap.endsWith('.read');
}

/**
 * Check whether `ctx`'s role has `cap` on this tenant. Default-deny: missing
 * from the map means false. Constant-time `.includes` is fine at this scale
 * (≤ 30 caps × 4 roles).
 */
export function can(ctx: AuthzContext, cap: Capability): boolean {
  if (ctx.suspended && !isReadCapability(cap)) return false;
  const map = ctx.isPlatform ? PLATFORM_CAPS : PARTNER_CAPS;
  return map[ctx.role].includes(cap);
}

/**
 * Whether a member holding `actor` may grant `role`, or change or remove a
 * member who holds it: never above their own. The capabilities say who may
 * manage the team at all; this keeps a Manager from making anyone an Owner
 * (themselves included) or unmaking one.
 */
export function canActOnRole(actor: TenantRole, role: TenantRole): boolean {
  return ROLE_RANK[actor] >= ROLE_RANK[role];
}
