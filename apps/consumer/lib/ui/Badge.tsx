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

// Pill tags on a thin ink outline — brand-sheet "tag" style.
const toneClasses: Record<BadgeTone, string> = {
  open:    'bg-surface-2 text-ink-soft',
  held:    'bg-tone-warning-bg text-tone-warning-text',
  blocked: 'bg-surface-2 text-ink-soft line-through',
  booked:  'bg-tone-booked-bg text-tone-booked-text',
  neutral: 'bg-surface-2 text-ink-soft',
  success: 'bg-tone-success-bg text-tone-success-text',
  warning: 'bg-tone-warning-bg text-tone-warning-text',
  danger:  'bg-tone-danger-bg text-tone-danger-text',
  sport:   'bg-coral-soft text-coral-deep',
};

export function Badge({ tone = 'neutral', label, className = '', ...rest }: BadgeProps) {
  return (
    <span
      className={[
        'inline-flex items-center rounded-full border-[1.5px] border-ink px-2.5 py-0.5',
        'text-xs font-semibold tracking-wide',
        toneClasses[tone],
        className,
      ].join(' ')}
      {...rest}
    >
      {label}
    </span>
  );
}
