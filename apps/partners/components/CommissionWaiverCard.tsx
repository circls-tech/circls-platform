'use client';

import { useCommissionWaiver } from '@/lib/api/queries';
import type { CommissionWaiver } from '@/lib/api/types';
import { Card } from '@/lib/ui';

/** Default length of the period — apps/api/src/services/commission_waiver.ts. */
const WAIVER_MONTHS = 3;

const DAY_FMT = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'UTC',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

/** '2027-01-24' → '24 January 2027'. A calendar day, so no zone shift. */
function fmtDay(day: string): string {
  return DAY_FMT.format(new Date(`${day}T00:00:00Z`));
}

/** 500 → '5%', 250 → '2.5%'. */
function fmtPct(bps: number): string {
  return `${bps / 100}%`;
}

/** What applies once the period is over: the stated rate, else the agreement. */
function afterSentence(w: CommissionWaiver, from: string): string {
  return w.afterWaiverBps !== null
    ? `From ${from}, Circls’ commission is ${fmtPct(w.afterWaiverBps)} of each sale.`
    : `From ${from}, commission applies at the rate in your Partner Agreement.`;
}

/**
 * The org's commission-free period, on Earnings: every org's first 3 months
 * from its first paid booking carry no Circls commission. States what was
 * promised — the API computes the dates, admins can move them.
 */
export function CommissionWaiverCard({
  tenantId,
  enabled,
}: {
  tenantId: string;
  enabled: boolean;
}) {
  const { data: w } = useCommissionWaiver(tenantId, enabled);
  // Nothing to say until it loads; a failed fetch shouldn't block Earnings.
  if (!w) return null;

  if (w.status === 'active' && w.startsOn && w.endsOn) {
    return (
      <Card className="!bg-emerald-50">
        <p className="font-[family-name:var(--font-display)] text-base font-bold text-[#17151D]">
          Commission-free until {fmtDay(w.endsOn)}
        </p>
        <p className="mt-1 text-sm text-slate-600">
          Circls takes no commission on your sales until then. Your commission-free period started
          on {fmtDay(w.startsOn)}
          {w.startSetByAdmin ? '' : ', the day of your first paid booking'}. {afterSentence(w, fmtDay(w.endsOn))}
        </p>
      </Card>
    );
  }

  if (w.status === 'not_started') {
    return (
      <Card className="!bg-emerald-50">
        <p className="font-[family-name:var(--font-display)] text-base font-bold text-[#17151D]">
          {w.startsOn
            ? `Commission-free from ${fmtDay(w.startsOn)}`
            : `Your first ${WAIVER_MONTHS} months are commission-free`}
        </p>
        <p className="mt-1 text-sm text-slate-600">
          {w.startsOn && w.endsOn
            ? `Circls takes no commission on your sales from ${fmtDay(w.startsOn)} until ${fmtDay(w.endsOn)}. `
            : `The ${WAIVER_MONTHS} months start with your first paid booking: from then, Circls takes no commission on your sales. `}
          {w.startsOn && w.endsOn ? afterSentence(w, fmtDay(w.endsOn)) : ''}
        </p>
      </Card>
    );
  }

  if (w.status === 'ended' && w.endsOn) {
    return (
      <Card>
        <p className="text-sm text-slate-600">
          Your commission-free period ended on {fmtDay(w.endsOn)}.{' '}
          {w.afterWaiverBps !== null
            ? `Circls’ commission is now ${fmtPct(w.afterWaiverBps)} of each sale.`
            : 'Commission now applies at the rate in your Partner Agreement.'}
        </p>
      </Card>
    );
  }

  return null;
}
