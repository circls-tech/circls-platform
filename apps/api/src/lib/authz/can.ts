import type { TenantRole } from '../../db/schema/tenant_members.js';
import type { Capability } from './capabilities.js';
import { PARTNER_CAPS, PLATFORM_CAPS } from './role_caps.js';

export interface AuthzContext {
  role: TenantRole;
  isPlatform: boolean;
}

/**
 * Check whether `ctx`'s role has `cap` on this tenant. Default-deny: missing
 * from the map means false. Constant-time `.includes` is fine at this scale
 * (≤ 30 caps × 4 roles).
 */
export function can(ctx: AuthzContext, cap: Capability): boolean {
  const map = ctx.isPlatform ? PLATFORM_CAPS : PARTNER_CAPS;
  return map[ctx.role].includes(cap);
}
