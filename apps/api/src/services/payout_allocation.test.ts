import { describe, expect, it } from 'vitest';
import { allocatePayoutLines, type PayoutTotals, type RawItemAggregate } from './payout_allocation.js';

/**
 * These lines become individually payable, so the only property that really
 * matters is that they sum to the payout — exactly, in every shape of week.
 */
const sumOf = (lines: { amountPaise: number }[]): number =>
  lines.reduce((a, l) => a + l.amountPaise, 0);

function totals(p: Partial<PayoutTotals>): PayoutTotals {
  const t = { gross: 0, refunds: 0, commission: 0, advances: 0, advanceRecouped: 0, ...p };
  return { ...t, amount: t.gross - t.refunds - t.commission + t.advances - t.advanceRecouped };
}

describe('allocatePayoutLines', () => {
  it('splits a plain week by item, net of each item s own commission', () => {
    const items: RawItemAggregate[] = [
      { itemType: 'event', itemId: 'e1', gross: 100000, refunds: 0, commission: 10000 },
      { itemType: 'slot', itemId: 'v1', gross: 50000, refunds: 0, commission: 5000 },
    ];
    const lines = allocatePayoutLines(items, totals({ gross: 150000, commission: 15000 }));

    expect(lines).toHaveLength(2);
    expect(lines[0]?.amountPaise).toBe(90000);
    expect(lines[1]?.amountPaise).toBe(45000);
    expect(sumOf(lines)).toBe(135000);
  });

  it('deducts each item s own refunds', () => {
    const items: RawItemAggregate[] = [
      { itemType: 'event', itemId: 'e1', gross: 100000, refunds: 30000, commission: 10000 },
      { itemType: 'slot', itemId: 'v1', gross: 50000, refunds: 0, commission: 5000 },
    ];
    const lines = allocatePayoutLines(items, totals({ gross: 150000, refunds: 30000, commission: 15000 }));

    // The refund lands on the item it was raised against, not spread.
    expect(lines[0]?.amountPaise).toBe(60000);
    expect(lines[1]?.amountPaise).toBe(45000);
  });

  it('allocates a CLAMPED commission pro-rata by each item s own commission', () => {
    // The week's clamp cut commission from 15,000 to 9,000. Each item should
    // carry its share of the cut, in proportion to what it owed.
    const items: RawItemAggregate[] = [
      { itemType: 'event', itemId: 'e1', gross: 100000, refunds: 0, commission: 10000 },
      { itemType: 'slot', itemId: 'v1', gross: 50000, refunds: 0, commission: 5000 },
    ];
    const lines = allocatePayoutLines(items, totals({ gross: 150000, commission: 9000 }));

    expect(lines[0]?.commissionPaise).toBe(6000); // 10/15 of 9,000
    expect(lines[1]?.commissionPaise).toBe(3000); // 5/15 of 9,000
    expect(sumOf(lines)).toBe(141000);
  });

  it('never moves commission onto an item that owed none', () => {
    // A free or fully-discounted sale has zero snapshot commission. Allocating
    // by gross instead of commission would wrongly charge it.
    const items: RawItemAggregate[] = [
      { itemType: 'event', itemId: 'paid', gross: 100000, refunds: 0, commission: 12000 },
      { itemType: 'membership', itemId: 'free', gross: 80000, refunds: 0, commission: 0 },
    ];
    const lines = allocatePayoutLines(items, totals({ gross: 180000, commission: 9000 }));

    expect(lines[0]?.commissionPaise).toBe(9000);
    expect(lines[1]?.commissionPaise).toBe(0);
    expect(lines[1]?.amountPaise).toBe(80000);
  });

  it('loses no paise to rounding, however awkward the ratio', () => {
    // Three equal commissions against a total that does not divide by three:
    // naive rounding drops a paisa, largest-remainder does not.
    const items: RawItemAggregate[] = [1, 2, 3].map((n) => ({
      itemType: 'slot' as const,
      itemId: `v${n}`,
      gross: 10000,
      refunds: 0,
      commission: 1000,
    }));
    const lines = allocatePayoutLines(items, totals({ gross: 30000, commission: 1000 }));

    expect(lines.map((l) => l.commissionPaise).reduce((a, b) => a + b)).toBe(1000);
    expect(sumOf(lines)).toBe(29000);
    // No 'unattributed' line: the rounding was absorbed by the allocation, not
    // pushed into a residual.
    expect(lines.every((l) => l.itemType === 'slot')).toBe(true);
  });

  it('gives advances their own line instead of smearing them across items', () => {
    const items: RawItemAggregate[] = [
      { itemType: 'event', itemId: 'e1', gross: 100000, refunds: 0, commission: 10000 },
    ];
    const lines = allocatePayoutLines(items, totals({ gross: 100000, commission: 10000, advances: 25000 }));

    const advance = lines.find((l) => l.itemType === 'advance');
    expect(advance?.amountPaise).toBe(25000);
    // The event's own figure is untouched by the financing.
    expect(lines.find((l) => l.itemType === 'event')?.amountPaise).toBe(90000);
    expect(sumOf(lines)).toBe(115000);
  });

  it('nets a recouped advance against the advance line, and drops it when it cancels', () => {
    const items: RawItemAggregate[] = [
      { itemType: 'event', itemId: 'e1', gross: 100000, refunds: 0, commission: 10000 },
    ];
    const both = allocatePayoutLines(
      items,
      totals({ gross: 100000, commission: 10000, advances: 25000, advanceRecouped: 25000 }),
    );
    // Captured and released in the same week: the tranches cancel, so there is
    // no advance line to show.
    expect(both.find((l) => l.itemType === 'advance')).toBeUndefined();
    expect(sumOf(both)).toBe(90000);
  });

  it('surfaces money the item aggregates could not explain', () => {
    // The tenant-level total says 100,000 but the items only account for
    // 90,000 — that gap is reported, never absorbed into an item.
    const items: RawItemAggregate[] = [
      { itemType: 'event', itemId: 'e1', gross: 100000, refunds: 0, commission: 10000 },
    ];
    const lines = allocatePayoutLines(items, { ...totals({ gross: 110000, commission: 10000 }) });

    const residual = lines.find((l) => l.itemType === 'unattributed');
    expect(residual?.amountPaise).toBe(10000);
    expect(lines.find((l) => l.itemType === 'event')?.amountPaise).toBe(90000);
    expect(sumOf(lines)).toBe(100000);
  });

  it('reconciles a week with no items at all', () => {
    // An advances-only week: money captured, nothing settled yet.
    const lines = allocatePayoutLines([], totals({ advances: 40000 }));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.itemType).toBe('advance');
    expect(sumOf(lines)).toBe(40000);
  });

  it('keeps an unattributable item as its own line rather than dropping it', () => {
    const items: RawItemAggregate[] = [
      { itemType: 'slot', itemId: null, gross: 50000, refunds: 0, commission: 5000 },
    ];
    const lines = allocatePayoutLines(items, totals({ gross: 50000, commission: 5000 }));
    expect(lines[0]?.itemId).toBeNull();
    expect(sumOf(lines)).toBe(45000);
  });
});
