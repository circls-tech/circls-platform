import type { ReactNode } from 'react';
import { BrandMark } from '@/lib/ui';

export function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-card border-[2.5px] border-ink bg-white px-6 py-12 text-center shadow-offset">
      <div
        aria-hidden
        className="mb-5 flex h-20 w-20 items-center justify-center rounded-full border-[2.5px] border-ink bg-surface-2 text-ink shadow-offset-sm"
      >
        <BrandMark className="h-11 w-11" />
      </div>
      <h3 className="font-display text-xl font-extrabold text-ink">{title}</h3>
      <p className="mt-1.5 max-w-sm text-sm text-text-secondary">{body}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
