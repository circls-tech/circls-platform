import type { CommissionWaiver } from './api/types';

const DAY_FMT = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'UTC',
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});

/** '2027-01-24' → '24 Jan 2027'. A calendar day, so no zone shift. */
export function fmtDay(day: string | null): string {
  return day ? DAY_FMT.format(new Date(`${day}T00:00:00Z`)) : '—';
}

/** Whole days from `from` to `to` (both YYYY-MM-DD). Calendar arithmetic, so
 *  no zone is involved: `today` comes from the API, already in the org's zone. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** YYYY-MM-DD plus `months`, clamped to the month's last day — the same as
 *  addMonths in apps/api/src/services/commission_waiver.ts. */
export function addMonths(day: string, months: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(Math.min(d, lastDay))}`;
}

/**
 * The period as it will read once the dates being edited are saved ('' = use
 * the default): the API's resolveCommissionWaiver rules, judged on the
 * org-zone `today` the API sent, so the card never shows stale defaults.
 */
export function previewWaiver(saved: CommissionWaiver, start: string, end: string): CommissionWaiver {
  const startsOn = start || saved.firstPaidOn;
  const endsOn = end || (startsOn ? addMonths(startsOn, saved.months) : null);
  const status: CommissionWaiver['status'] =
    endsOn !== null && saved.today >= endsOn
      ? 'ended'
      : startsOn === null || saved.today < startsOn
        ? 'not_started'
        : 'active';
  return { ...saved, status, startsOn, endsOn, startSetByAdmin: start !== '', endSetByAdmin: end !== '' };
}

/**
 * One-line state of the commission-free period, plus a pill tone. Null when
 * the API sent no waiver — an API older than this portal, mid-deploy — so
 * callers render nothing rather than crash.
 */
export function waiverSummary(
  w: CommissionWaiver | undefined,
): { label: string; tone: string } | null {
  if (!w) return null;
  if (w.status === 'active') {
    return { label: `Free until ${fmtDay(w.endsOn)}`, tone: 'bg-emerald-100 text-emerald-800' };
  }
  if (w.status === 'ended') {
    return { label: `Ended ${fmtDay(w.endsOn)}`, tone: 'bg-slate-100 text-slate-600' };
  }
  return w.startsOn
    ? { label: `Starts ${fmtDay(w.startsOn)}`, tone: 'bg-amber-50 text-amber-700' }
    : { label: 'From first paid booking', tone: 'bg-amber-50 text-amber-700' };
}
