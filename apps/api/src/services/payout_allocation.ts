/**
 * Splitting a payout into the item lines it paid for.
 *
 * WHY THIS IS NOT JUST A GROUP BY. A payout's amount is computed from the
 * week's TOTALS — `clampCommissionPaise` clamps commission against the week's
 * gross and refunds, and advance tranches are tenant-level financing with no
 * item behind them at all. So `sum(per-item net)` does not equal
 * `payouts.amount_paise` on its own, and a naive per-item query would produce
 * lines that quietly disagree with the money that was actually transferred.
 *
 * This module is the allocation policy that closes that gap. It takes the
 * per-item aggregates and the payout's own totals and returns lines that sum
 * to the payout EXACTLY — a property the caller asserts rather than hopes for,
 * because these lines become individually payable and a rounding error here is
 * money that can be marked paid twice or never.
 *
 * THE RULES, and why each one:
 *
 *   1. Commission is allocated pro-rata by each item's own snapshot commission,
 *      not by gross. The clamp reduces commission, so the reduction belongs to
 *      the items that contributed commission, in proportion to how much they
 *      contributed. Allocating by gross would move commission onto a
 *      zero-commission item (a free or fully-discounted sale) that never owed
 *      any.
 *
 *   2. Rounding uses largest-remainder, not per-item rounding. Rounding each
 *      share independently loses or invents paise; largest-remainder hands the
 *      leftover to the items with the biggest fractional parts, so the parts
 *      sum to the clamped total by construction.
 *
 *   3. Advances get their OWN line rather than being spread. An advance is
 *      money Circls fronted against the tenant's future sales — it is not
 *      attributable to an event or a venue even in principle, and smearing it
 *      across items would make each item's figure a fiction. A dedicated line
 *      keeps the sum honest while naming the money for what it is.
 *
 *   4. Anything still unexplained becomes an `unattributed` line rather than
 *      being absorbed. getPayoutBreakdown already reports a residual for the
 *      same reason: money that cannot be attributed is a fact to surface, not
 *      a discrepancy to hide in the nearest row.
 */

/** A payout line's subject. The last two are money with no item behind it. */
export type PayoutLineType = 'slot' | 'event' | 'membership' | 'advance' | 'unattributed';

/** Per-item aggregates for one payout window, before any clamp is applied. */
export interface RawItemAggregate {
  itemType: 'slot' | 'event' | 'membership';
  /** Venue id for a slot, event id, plan id. Null when unattributable. */
  itemId: string | null;
  /** Settleable base of this item's charges, in minor units. */
  gross: number;
  /** Refunds against it, as a POSITIVE number. */
  refunds: number;
  /** Snapshot commission on its charges, before the weekly clamp. */
  commission: number;
}

/** The payout row's own figures — the totals the lines must reconcile to. */
export interface PayoutTotals {
  gross: number;
  refunds: number;
  /** AFTER clampCommissionPaise. */
  commission: number;
  advances: number;
  advanceRecouped: number;
  /** gross − refunds − commission + advances − advanceRecouped. */
  amount: number;
}

export interface PayoutLine {
  itemType: PayoutLineType;
  itemId: string | null;
  grossPaise: number;
  refundsPaise: number;
  commissionPaise: number;
  amountPaise: number;
}

/**
 * Split `totals` across `items`, returning lines that sum to `totals.amount`.
 *
 * @throws if the lines do not reconcile — a bug in this function rather than
 *   bad input, and one that must never reach the database, since these lines
 *   are what an admin marks paid.
 */
export function allocatePayoutLines(
  items: RawItemAggregate[],
  totals: PayoutTotals,
): PayoutLine[] {
  const commissionByItem = allocateProRata(
    items.map((i) => i.commission),
    totals.commission,
  );

  const lines: PayoutLine[] = items.map((item, idx) => {
    const commission = commissionByItem[idx] ?? 0;
    return {
      itemType: item.itemType,
      itemId: item.itemId,
      grossPaise: item.gross,
      refundsPaise: item.refunds,
      commissionPaise: commission,
      amountPaise: item.gross - item.refunds - commission,
    };
  });

  // Advances net of what was recouped this week. A week that fires both
  // tranches for the same charge cancels to zero and earns no line.
  const advanceNet = totals.advances - totals.advanceRecouped;
  if (advanceNet !== 0) {
    lines.push({
      itemType: 'advance',
      itemId: null,
      grossPaise: 0,
      refundsPaise: 0,
      commissionPaise: 0,
      amountPaise: advanceNet,
    });
  }

  // Whatever the item aggregates could not account for. Non-zero means the
  // per-item query and the tenant-level query disagree about the same window —
  // worth seeing, not worth hiding.
  const residual = totals.amount - lines.reduce((sum, l) => sum + l.amountPaise, 0);
  if (residual !== 0) {
    lines.push({
      itemType: 'unattributed',
      itemId: null,
      grossPaise: 0,
      refundsPaise: 0,
      commissionPaise: 0,
      amountPaise: residual,
    });
  }

  const sum = lines.reduce((acc, l) => acc + l.amountPaise, 0);
  if (sum !== totals.amount) {
    throw new Error(
      `payout allocation does not reconcile: lines sum to ${sum}, payout is ${totals.amount}`,
    );
  }
  return lines;
}

/**
 * Split `total` across `weights` in proportion, with the parts summing to
 * `total` exactly.
 *
 * Largest-remainder: floor every share, then hand the shortfall one paisa at a
 * time to the largest fractional parts. With all-zero weights nothing can be
 * apportioned, so everything stays unallocated and the caller's residual line
 * picks it up — silently spreading it evenly would invent commission on items
 * that never owed any.
 */
function allocateProRata(weights: number[], total: number): number[] {
  const weightSum = weights.reduce((a, w) => a + w, 0);
  if (weightSum <= 0 || total === 0) return weights.map(() => 0);

  const exact = weights.map((w) => (w * total) / weightSum);
  const floors = exact.map((e) => Math.floor(e));
  let remaining = total - floors.reduce((a, f) => a + f, 0);

  const order = exact
    .map((e, idx) => ({ idx, frac: e - Math.floor(e) }))
    .sort((a, b) => b.frac - a.frac || a.idx - b.idx);

  const out = [...floors];
  for (const { idx } of order) {
    if (remaining <= 0) break;
    out[idx] = (out[idx] ?? 0) + 1;
    remaining -= 1;
  }
  return out;
}
