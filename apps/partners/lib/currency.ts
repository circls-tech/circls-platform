'use client';
/**
 * Display currency for prices in the partner portal.
 *
 * Prices are stored in minor units (the legacy `*Paise` fields hold paise for
 * INR venues and cents for USD venues) and are denominated by where the venue
 * settles: this mirrors the API's gateway rule (apps/api/src/lib/gateway.ts
 * `providerForCountry`) — venues in the USA settle in USD via Stripe, everything
 * else in INR via Razorpay. Org-level surfaces (dashboard, coupons, org-wide
 * plans) fall back to the tenant's country.
 */
import { useOrg } from '@/lib/org_context';
import { useTenantProfile, useVenue, useVenues } from '@/lib/api/queries';

export type CurrencyCode = 'INR' | 'USD';

/**
 * Currency for a venue/tenant country. Country values are the canonical
 * 'India' | 'USA' strings (see the API's geocoding normalizeCountry), but be
 * lenient about US spellings; null/unknown falls back to INR.
 */
export function currencyForCountry(country: string | null | undefined): CurrencyCode {
  const c = (country ?? '').trim().toLowerCase();
  return c === 'usa' || c === 'us' || c === 'united states' ? 'USD' : 'INR';
}

export function currencySymbol(currency: CurrencyCode): '₹' | '$' {
  return currency === 'USD' ? '$' : '₹';
}

/** Narrow an API-provided currency string (e.g. a payment row's `currency`)
 *  to a known display currency; unknown values fall back to INR. */
export function asCurrencyCode(currency: string | null | undefined): CurrencyCode {
  return currency?.toUpperCase() === 'USD' ? 'USD' : 'INR';
}

const LOCALE_FOR: Record<CurrencyCode, string> = { INR: 'en-IN', USD: 'en-US' };

const formatterCache = new Map<string, Intl.NumberFormat>();
function numberFormat(currency: CurrencyCode, decimals: number): Intl.NumberFormat {
  const key = `${currency}:${decimals}`;
  let f = formatterCache.get(key);
  if (!f) {
    f = new Intl.NumberFormat(LOCALE_FOR[currency], {
      style: 'currency',
      currency,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
    formatterCache.set(key, f);
  }
  return f;
}

/**
 * Format minor units (paise/cents) as a currency amount, e.g.
 * (150000, 'INR') → "₹1,500" and (150000, 'USD', {decimals: 2}) → "$1,500.00".
 */
export function formatMoney(
  minorUnits: number,
  currency: CurrencyCode,
  opts: { decimals?: 0 | 2 } = {},
): string {
  return numberFormat(currency, opts.decimals ?? 0).format(minorUnits / 100);
}

/**
 * The display currency for the current context. Resolution order:
 * an explicit `country` (e.g. a standalone event's address country) →
 * the venue's country (when `venueId` is passed) → the active tenant's
 * country → INR.
 *
 * While the venue/tenant queries are in flight this returns INR; callers
 * render a brief default that corrects itself, which is fine for labels.
 */
export function useCurrency(opts: { venueId?: string | null; country?: string | null } = {}): CurrencyCode {
  const { activeTenantId } = useOrg();
  const { data: venue } = useVenue(opts.venueId ?? '');
  const { data: tenant } = useTenantProfile(activeTenantId ?? '');
  return currencyForCountry(opts.country ?? venue?.country ?? tenant?.country);
}

/**
 * Per-row currency resolution for tenant-level lists whose rows are venue-scoped
 * (memberships, org events): one venues query instead of a query per row.
 * `currencyFor(venueId)` falls back to the tenant currency for org-wide rows
 * (null venueId) or venues not in the list.
 */
export function useVenueCurrencies(): {
  tenantCurrency: CurrencyCode;
  currencyFor: (venueId: string | null | undefined) => CurrencyCode;
} {
  const { activeTenantId } = useOrg();
  const { data: venues } = useVenues(activeTenantId ?? '');
  const { data: tenant } = useTenantProfile(activeTenantId ?? '');
  const tenantCurrency = currencyForCountry(tenant?.country);
  const byVenue = new Map<string, CurrencyCode>();
  for (const v of venues ?? []) {
    if (v.country) byVenue.set(v.id, currencyForCountry(v.country));
  }
  return {
    tenantCurrency,
    currencyFor: (venueId) => (venueId ? (byVenue.get(venueId) ?? tenantCurrency) : tenantCurrency),
  };
}
