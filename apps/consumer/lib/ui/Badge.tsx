import { HTMLAttributes } from 'react';

export type BadgeTone =
  | 'open'
  | 'held'
  | 'blocked'
  | 'booked'
  | 'neutral'
  | 'success'
  | 'warning'
  | 'danger'
  | 'sport';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  label: string;
}

// Soft petal chips — pastel fill, ink text, no outline.
const toneClasses: Record<BadgeTone, string> = {
  open:    'bg-surface-2 text-ink-soft',
  held:    'bg-tone-warning-bg text-tone-warning-text',
  blocked: 'bg-surface-2 text-ink-soft line-through',
  booked:  'bg-tone-booked-bg text-tone-booked-text',
  neutral: 'bg-surface-2 text-ink-soft',
  success: 'bg-tone-success-bg text-tone-success-text',
  warning: 'bg-tone-warning-bg text-tone-warning-text',
  danger:  'bg-tone-danger-bg text-tone-danger-text',
  sport:   'text-ink', // fill comes from petalFor(label)
};

// Brand petals for sport tags; the label hash keeps each tag's colour stable
// across cards and pages.
const SPORT_PETALS = ['bg-pastel-butter', 'bg-pastel-mint', 'bg-pastel-peach', 'bg-pastel-lilac'];
function petalFor(label: string): string {
  let h = 0;
  for (const ch of label) h = (h * 31 + ch.charCodeAt(0)) % 997;
  return SPORT_PETALS[h % SPORT_PETALS.length]!;
}

export function Badge({ tone = 'neutral', label, className = '', ...rest }: BadgeProps) {
  return (
    <span
      className={[
        'inline-flex items-center rounded-lg px-2.5 py-1',
        'text-xs font-semibold uppercase tracking-wide',
        toneClasses[tone],
        tone === 'sport' ? petalFor(label) : '',
        className,
      ].join(' ')}
      {...rest}
    >
      {label}
    </span>
  );
}
