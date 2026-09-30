'use client';
import type { PublicCoupon } from '@/lib/api/checkout';
import { formatPaiseExact } from '@/lib/format';
import type { CurrencyCode } from '@/lib/format';
import { Card } from '@/lib/ui';

/**
 * The public offers on an item, as codes you tap rather than codes you have to
 * already know. Tapping one carries it into checkout pre-applied.
 *
 * Shared by every item page, so a discount is found the same way whatever is
 * being bought — a strip that only existed on events taught customers that
 * venues and plans simply had no offers.
 *
 * `variant` is where it sits: `card` for a section of a page, `bare` for
 * somewhere that brings its own frame (the venue cart bar).
 */
export function OffersStrip({
  offers,
  currency,
  selected,
  onSelect,
  heading,
  variant = 'card',
}: {
  offers: PublicCoupon[];
  currency: CurrencyCode;
  selected: string | null;
  onSelect: (code: string | null) => void;
  /** e.g. "Offers for this event" — names the thing, in its own page's words. */
  heading: string;
  variant?: 'card' | 'bare';
}) {
  if (offers.length === 0) return null;
  const description = offers.find((o) => o.code === selected)?.description;

  const body = (
    <>
      <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary">{heading}</p>
      {/* In the bar the chips are capped and scroll, like the cart list
          beside them: a tenant running six public codes would otherwise wrap
          them over six rows and take most of a phone screen. */}
      <div
        className={[
          'mt-2 flex flex-wrap gap-2',
          variant === 'bare' ? 'max-h-28 overflow-y-auto' : '',
        ].join(' ')}
      >
        {offers.map((o) => {
          const isSelected = o.code === selected;
          return (
            <button
              key={o.code}
              type="button"
              aria-pressed={isSelected}
              onClick={() => onSelect(isSelected ? null : o.code)}
              className={[
                'rounded-[var(--radius)] border-[2px] border-dashed border-ink px-3 py-1.5 text-sm font-semibold',
                isSelected ? 'bg-ink text-white' : 'bg-white text-ink hover:bg-ink/5',
              ].join(' ')}
            >
              {o.code}
              <span className={isSelected ? 'font-normal opacity-80' : 'font-normal text-text-secondary'}>
                {' '}· {offerLabel(o, currency)}
              </span>
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-text-secondary">
        {selected
          ? `${selected} will be applied at checkout.${description ? ` ${description}` : ''}`
          : 'Tap a code to use it — it’s applied when you book.'}
      </p>
    </>
  );

  if (variant === 'bare') {
    return <div className="border-b-[1.5px] border-dashed border-ink/20 py-3">{body}</div>;
  }
  return (
    <section className="mt-6">
      <Card>{body}</Card>
    </section>
  );
}

function offerLabel(o: PublicCoupon, currency: CurrencyCode): string {
  return o.discountType === 'percent'
    ? `${o.discountValue / 100}% off`
    : `${formatPaiseExact(o.discountValue, currency)} off`;
}
