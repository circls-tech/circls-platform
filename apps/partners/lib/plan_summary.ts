import { type CurrencyCode, formatMoney } from './currency';
import type { Membership } from './api/types';

/**
 * What a membership plan costs, in one line.
 *
 * Shared because it is shown in two places — the Memberships list and the
 * dashboard — and when each had its own copy they drifted immediately: one
 * said "Free" where the other said "₹0", one carried decimals and the other
 * rounded them away, and the same plan read differently depending on which
 * page you were looking at.
 */

/** A price as partners read it. Zero is a word, not an amount. */
export function fmtPrice(pricePaise: number, currency: CurrencyCode): string {
  return pricePaise === 0 ? 'Free' : formatMoney(pricePaise, currency, { decimals: 2 });
}

/**
 * The plan's tier count and price range — "3 tiers · ₹500.00–₹2,000.00".
 *
 * A plan predating tiers has none to summarise, so it falls back to its own
 * legacy price. Reporting "0 tiers" reads as a fault rather than as an older
 * plan shape, and a dash tells the partner nothing at all.
 *
 * `currency` must be resolved from the plan's own venue — an org selling in
 * two markets has plans in two currencies, and the tenant's default is the
 * wrong answer for one of them.
 */
export function planSummary(plan: Membership, currency: CurrencyCode): string {
  const prices = plan.tiers.map((t) => t.pricePaise);
  if (prices.length === 0) return fmtPrice(plan.pricePaise, currency);

  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range =
    min === max ? fmtPrice(min, currency) : `${fmtPrice(min, currency)}–${fmtPrice(max, currency)}`;
  const count = `${plan.tiers.length} ${plan.tiers.length === 1 ? 'tier' : 'tiers'}`;
  return `${count} · ${range}`;
}
