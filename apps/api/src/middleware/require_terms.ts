import { Forbidden } from '../lib/errors.js';
import { CURRENT_TERMS_VERSION } from '../lib/terms.js';
import type { TenantContext } from './tenant_context.js';

/**
 * Gate on Terms & Conditions acceptance. Called after requireTenantMembership
 * on the routes that create new listings (venues, events, memberships): an org
 * that never accepted — or accepted a superseded revision — must (re-)accept
 * before it can put new inventory in front of consumers. Reads and existing
 * inventory stay available. The internal platform tenant is exempt (it is not
 * a partner).
 */
export function assertTermsAccepted(ctx: TenantContext): void {
  if (ctx.isPlatform) return;
  if (!ctx.termsAcceptedAt || ctx.termsVersion !== CURRENT_TERMS_VERSION) {
    throw new Forbidden(
      'The organisation must accept the current Terms & Conditions before creating new listings',
      'terms_required',
      { currentVersion: CURRENT_TERMS_VERSION },
    );
  }
}
