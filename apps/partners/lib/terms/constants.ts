import type { Tenant } from '@/lib/api/types';

/**
 * Partner Terms & Conditions versioning — mirrors the API's authority in
 * apps/api/src/lib/terms.ts (same pattern as lib/currency.ts mirroring the
 * gateway's currencyForCountry). Keep the two constants in sync: the accept
 * endpoint 409s ('terms_version_stale') if this client falls behind.
 */
export const CURRENT_TERMS_VERSION = '2026-07-19.v1';

export type TermsRegion = 'US' | 'IN';

/** Canonical country strings the API accepts (gazetteer spellings). */
export const TERMS_COUNTRY_OPTIONS = [
  { value: 'India', label: 'India', region: 'IN' as TermsRegion },
  { value: 'USA', label: 'United States', region: 'US' as TermsRegion },
] as const;

export type TermsCountry = (typeof TERMS_COUNTRY_OPTIONS)[number]['value'];

export function termsRegionForCountry(country: string | null | undefined): TermsRegion {
  const c = (country ?? '').trim().toUpperCase();
  const isUs = c === 'US' || c === 'USA' || c === 'UNITED STATES' || c === 'UNITED STATES OF AMERICA';
  return isUs ? 'US' : 'IN';
}

/**
 * Whether the org must (re-)accept before it can create venues, events or
 * memberships. Matches the server's assertTermsAccepted: never accepted, or
 * accepted a superseded revision.
 */
export function needsTermsAcceptance(tenant: Pick<Tenant, 'termsVersion' | 'termsAcceptedAt' | 'isPlatform'>): boolean {
  if (tenant.isPlatform) return false;
  return !tenant.termsAcceptedAt || tenant.termsVersion !== CURRENT_TERMS_VERSION;
}
