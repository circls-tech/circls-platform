import { isUsCountry } from './gateway.js';

/**
 * Partner Terms & Conditions versioning. The full document text ships with the
 * partners app (apps/partners/lib/terms/) — the API is the authority on which
 * revision is current and which regional document applies to an org.
 *
 * Bumping CURRENT_TERMS_VERSION re-gates every org: the portal blocks creating
 * venues/events/memberships until an owner/manager accepts the new revision.
 * Keep the mirrored constant in apps/partners/lib/terms/constants.ts in sync.
 */
export const CURRENT_TERMS_VERSION = '2026-07-19.v1';

/** Which regional Terms document an org signs. */
export type TermsRegion = 'US' | 'IN';

/**
 * US orgs sign the US document; everyone else signs the India document —
 * mirroring the payment-gateway split (Stripe/USD vs Razorpay/INR).
 */
export function termsRegionForCountry(country: string | null | undefined): TermsRegion {
  return isUsCountry(country) ? 'US' : 'IN';
}
