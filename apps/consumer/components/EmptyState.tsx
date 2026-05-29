import type { ReactNode } from 'react';

const MOTIF_GRID: React.CSSProperties = {
  backgroundImage:
    'linear-gradient(var(--color-gold-500) 2px, transparent 2px), linear-gradient(90deg, var(--color-gold-500) 2px, transparent 2px)',
  backgroundSize: '26px 26px',
};

export function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-card border border-border bg-white px-6 py-12 text-center">
      <div aria-hidden className="relative mb-4 h-20 w-28 overflow-hidden rounded-md bg-ink">
        <div className="absolute inset-0 opacity-20" style={MOTIF_GRID} />
        <div className="absolute inset-3 rounded border-2 border-gold-500/50" />
      </div>
      <h3 className="font-display text-lg font-semibold text-ink">{title}</h3>
      <p className="mt-1 max-w-sm text-sm text-text-secondary">{body}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
