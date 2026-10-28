'use client';

/**
 * A 1–10 rating picker: ten numbered tiles in one row (they fit a 375px phone
 * inside the modal), with the ends labelled underneath. Optionally offers
 * "Haven't tried yet" for questions that may not apply — selecting it clears
 * the number and vice versa.
 */

export const NOT_TRIED = 'not_tried' as const;
/** A number, "haven't tried", or not answered yet. */
export type ScaleValue = number | typeof NOT_TRIED | null;

export function RatingScale({
  label,
  value,
  onChange,
  low = 'Not good',
  high = 'Loved it',
  notTriedLabel,
}: {
  /** The question; also the radiogroup's accessible name. */
  label: string;
  value: ScaleValue;
  onChange: (v: ScaleValue) => void;
  low?: string;
  high?: string;
  /** Show a "Haven't tried yet" choice with this text. */
  notTriedLabel?: string;
}) {
  const notTried = value === NOT_TRIED;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="font-display text-xs font-bold uppercase tracking-wide text-ink">{label}</span>
        {notTriedLabel && (
          <button
            type="button"
            aria-pressed={notTried}
            onClick={() => onChange(notTried ? null : NOT_TRIED)}
            className={[
              'shrink-0 rounded-full border-[2px] px-2.5 py-0.5 text-[11px] font-semibold transition-colors',
              notTried ? 'border-ink bg-lav text-ink' : 'border-ink/30 bg-white text-text-secondary hover:border-ink',
            ].join(' ')}
          >
            {notTriedLabel}
          </button>
        )}
      </div>
      <div role="radiogroup" aria-label={label} className="grid grid-cols-10 gap-1">
        {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => {
          const selected = value === n;
          return (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={`${n} out of 10`}
              onClick={() => onChange(n)}
              className={[
                'flex h-9 items-center justify-center rounded-[var(--radius)] border-[2px] text-sm font-bold tabular-nums transition-colors',
                selected
                  ? 'border-ink bg-coral text-ink'
                  : notTried
                    ? 'border-ink/20 bg-white text-text-muted'
                    : 'border-ink bg-white text-ink hover:bg-surface-2',
              ].join(' ')}
            >
              {n}
            </button>
          );
        })}
      </div>
      <div className="flex justify-between text-[11px] font-semibold text-text-secondary">
        <span>{low}</span>
        <span>{high}</span>
      </div>
    </div>
  );
}

/** A labelled optional textarea in the form style used across the site. */
export function NoteField({
  id,
  label,
  value,
  onChange,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="font-display text-xs font-bold uppercase tracking-wide text-ink">
        {label}
      </label>
      <textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={2}
        maxLength={2000}
        className="w-full rounded-[var(--radius)] border-[2px] border-ink bg-white px-3.5 py-2.5 text-sm text-ink placeholder:text-text-muted transition-colors duration-150 focus:border-coral-deep focus:outline-none"
      />
    </div>
  );
}

/** A scale answer as the API takes it: "haven't tried" and unanswered are null. */
export function scaleToRating(v: ScaleValue): number | null {
  return typeof v === 'number' ? v : null;
}
