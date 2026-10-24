import type { CommissionWaiver } from '@/lib/api/types';

const DAY_FMT = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'UTC',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

/** '2027-01-24' → '24 January 2027'. A calendar day, so no zone shift. */
export function fmtDay(day: string): string {
  return DAY_FMT.format(new Date(`${day}T00:00:00Z`));
}

/** 500 → '5%', 250 → '2.5%'. */
function fmtPct(bps: number): string {
  return `${bps / 100}%`;
}

export interface WaiverBanner {
  /** Highlighted while the period is ahead or running; plain once it ended. */
  highlight: boolean;
  title: string | null;
  body: string;
}

/**
 * What Earnings says about the org's commission-free period: every org's
 * first months from its first paid booking carry no Circls commission. States
 * what was promised; the API computes the dates and admins can move them.
 */
export function waiverBanner(w: CommissionWaiver): WaiverBanner | null {
  // What applies once the period is over: the stated rate, else the agreement.
  const afterIt = (from: string) =>
    w.afterWaiverBps !== null
      ? `From ${from}, Circls’ commission is ${fmtPct(w.afterWaiverBps)} of each sale.`
      : `From ${from}, commission applies at the rate in your Partner Agreement.`;

  if (w.status === 'active' && w.startsOn && w.endsOn) {
    const end = fmtDay(w.endsOn);
    const why = w.startSetByAdmin ? '' : ', the day of your first paid booking';
    return {
      highlight: true,
      title: `Commission-free until ${end}`,
      body: `Circls takes no commission on your sales until then. Your commission-free period started on ${fmtDay(w.startsOn)}${why}. ${afterIt(end)}`,
    };
  }

  if (w.status === 'not_started') {
    if (w.startsOn && w.endsOn) {
      const end = fmtDay(w.endsOn);
      return {
        highlight: true,
        title: `Commission-free from ${fmtDay(w.startsOn)}`,
        body: `Circls takes no commission on your sales from ${fmtDay(w.startsOn)} until ${end}. ${afterIt(end)}`,
      };
    }
    if (w.endsOn) {
      // No paid booking yet, but circls has fixed the end date.
      const end = fmtDay(w.endsOn);
      return {
        highlight: true,
        title: `Commission-free until ${end}`,
        body: `Your commission-free period starts with your first paid booking and runs until ${end}: Circls takes no commission on your sales in that time. ${afterIt(end)}`,
      };
    }
    return {
      highlight: true,
      title: `Your first ${w.months} months are commission-free`,
      body: `The ${w.months} months start with your first paid booking: from then, Circls takes no commission on your sales.`,
    };
  }

  if (w.status === 'ended' && w.endsOn) {
    return {
      highlight: false,
      title: null,
      body: `Your commission-free period ended on ${fmtDay(w.endsOn)}. ${
        w.afterWaiverBps !== null
          ? `Circls’ commission is now ${fmtPct(w.afterWaiverBps)} of each sale.`
          : 'Commission now applies at the rate in your Partner Agreement.'
      }`,
    };
  }

  return null;
}
