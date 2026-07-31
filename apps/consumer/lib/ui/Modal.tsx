'use client';

import { type ReactNode, useEffect, useId } from 'react';
import { createPortal } from 'react-dom';
import { isTopOverlay, popOverlay, pushOverlay } from './overlay_stack';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
}

export function Modal({ open, onClose, title, children }: ModalProps) {
  const overlayId = useId();
  // Escape-to-close via the shared overlay stack: only the topmost overlay
  // reacts, and body scroll is restored when the last overlay closes.
  useEffect(() => {
    if (!open) return;
    pushOverlay(overlayId);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isTopOverlay(overlayId)) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); popOverlay(overlayId); };
  }, [open, onClose, overlayId]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-ink/40" onClick={onClose} />
      <div className="relative z-10 w-full max-w-md rounded-t-[var(--radius-card)] border-[2px] border-ink bg-white p-5 shadow-offset sm:rounded-[var(--radius-card)]">
        {title != null && <h2 className="mb-4 font-display text-xl font-extrabold text-ink">{title}</h2>}
        {children}
      </div>
    </div>,
    document.body,
  );
}
