'use client';
import type { ScratchStatus } from '@/lib/preview';

/** What a scratch preview page shows until the form's listing has arrived. */
export function ScratchStatusNote({ status }: { status: ScratchStatus }) {
  return (
    <p className="text-sm text-text-secondary">
      {status === 'denied'
        ? 'This preview link is not valid any more — open the preview again from the form.'
        : status === 'unavailable'
          ? "The preview can't connect to the form right now. Your form is fine — try the preview again later."
          : status === 'verifying'
          ? 'Preparing the preview…'
          : 'Waiting for the form…'}
    </p>
  );
}
