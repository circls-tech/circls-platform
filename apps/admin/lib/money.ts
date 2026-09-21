/**
 * Money formatting for the admin console. Amounts are stored in minor units
 * (paise / cents) everywhere; these are the only two ways they are shown.
 */

export type CurrencyCode = 'INR' | 'USD';

const LOCALE: Record<CurrencyCode, string> = { INR: 'en-IN', USD: 'en-US' };

/**
 * A price with its symbol, trimming zero decimals: "₹1,234.5", "$12".
 * Zero reads "Free" and a missing value "—", so a table cell can call this
 * straight off an optional field.
 */
export function formatPrice(
  minor: number | null | undefined,
  currency: CurrencyCode = 'INR',
): string {
  if (minor == null) return '—';
  if (minor === 0) return 'Free';
  return new Intl.NumberFormat(LOCALE[currency], {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(minor / 100);
}

/**
 * A ledger amount: fixed two decimals, no symbol ("1,234.56"), for columns
 * whose header already names the currency.
 */
export function formatAmount(minor: number, currency: CurrencyCode = 'INR'): string {
  return (minor / 100).toLocaleString(LOCALE[currency], {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
