import type { CommissionWaiver } from './api/types';

/** Default length of the period — apps/api/src/services/commission_waiver.ts. */
export const COMMISSION_WAIVER_MONTHS = 3;

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

/** Whole days from today (IST) until `day`; 0 on the day itself. */
export function daysUntil(day: string): number {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  return Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

/** One-line state of the commission-free period, plus a pill tone. */
export function waiverSummary(w: CommissionWaiver): { label: string; tone: string } {
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
