import { HTMLAttributes } from 'react';

export type BadgeTone =
  | 'open'
  | 'held'
  | 'blocked'
  | 'booked'
  | 'neutral'
  | 'success'
  | 'warning'
  | 'danger';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  label: string;
}

const toneClasses: Record<BadgeTone, string> = {
  open:    'bg-slate-100 text-slate-600',
  held:    'bg-amber-100 text-amber-800',
  blocked: 'bg-zinc-100 text-zinc-600 line-through',
  booked:  'bg-blue-100 text-blue-800',
  neutral: 'bg-slate-100 text-slate-500',
  success: 'bg-green-100 text-green-800',
  warning: 'bg-yellow-100 text-yellow-800',
  danger:  'bg-red-100 text-red-700',
};

export function Badge({ tone = 'neutral', label, className = '', ...rest }: BadgeProps) {
  return (
    <span
      className={[
        'inline-flex items-center rounded-full px-2 py-0.5',
        'text-xs font-medium tracking-wide',
        toneClasses[tone],
        className,
      ].join(' ')}
      {...rest}
    >
      {label}
    </span>
  );
}
