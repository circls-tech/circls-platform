'use client';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { isTopOverlay, popOverlay, pushOverlay } from '@/lib/ui/overlay_stack';

/**
 * Right-side slide-over panel (HelpWidget pattern): portals to document.body
 * behind a `mounted` guard so the fixed overlay escapes the backdrop-blur
 * header (the PR #121 clipping bug), locks body scroll, and closes on Escape
 * or backdrop click. Children render inside a full-height flex column.
 */
export function SlideOver({
  open,
  onClose,
  title,
  ariaLabel,
  children,
}: {
  open: boolean;
  onClose: () => void;
  /** Header content, left of the close button. */
  title: ReactNode;
  ariaLabel: string;
  children: ReactNode;
}) {
  const [mounted, setMounted] = useState(false);
  const overlayId = useId();

  // Portal target is only available in the browser.
  useEffect(() => setMounted(true), []);

  // Escape-to-close + body-scroll lock via the shared overlay stack: only the
  // topmost overlay reacts to Escape, and scroll is restored when the last
  // overlay closes (nested open/close in any order is safe).
  useEffect(() => {
    if (!open) return;
    pushOverlay(overlayId);
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && isTopOverlay(overlayId)) onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      popOverlay(overlayId);
    };
  }, [open, onClose, overlayId]);

  if (!open || !mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={ariaLabel}>
      <div className="absolute inset-0 bg-ink/40" onClick={onClose} />
      <div className="absolute right-0 top-0 flex h-full w-full max-w-md flex-col border-l-[2px] border-ink bg-surface shadow-offset">
        <div className="flex items-center justify-between gap-3 border-b-[2px] border-ink px-4 py-3">
          <div className="flex min-w-0 flex-1 items-center gap-2">{title}</div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-xl font-bold leading-none text-ink-soft hover:text-ink"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
