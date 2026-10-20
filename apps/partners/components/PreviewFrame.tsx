'use client';

import type { RefObject } from 'react';
import type { ListingPreviewType } from '@/lib/api/preview';

/** What each listing type is called in preview copy. */
export const PREVIEW_NOUN: Record<ListingPreviewType, string> = {
  venue: 'venue',
  event: 'event',
  membership: 'plan',
};

export type PreviewDevice = 'phone' | 'desktop';

/** The Phone / Desktop switch above a preview frame. */
export function PreviewDeviceToggle({
  device,
  onChange,
}: {
  device: PreviewDevice;
  onChange: (d: PreviewDevice) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Preview size"
      className="inline-flex rounded-md border border-slate-200 bg-white p-0.5"
    >
      {(['phone', 'desktop'] as const).map((d) => (
        <button
          key={d}
          type="button"
          onClick={() => onChange(d)}
          aria-pressed={device === d}
          className={[
            'rounded px-2.5 py-1 text-xs font-medium capitalize transition-colors',
            device === d ? 'bg-slate-900 text-white' : 'text-slate-600 hover:text-slate-900',
          ].join(' ')}
        >
          {d}
        </button>
      ))}
    </div>
  );
}

/**
 * The framed consumer-site page shared by the listing previews: the ink
 * border, the pending and error copy while a link is minted, and the iframe
 * itself at phone or desktop width. The consumer site handles its own
 * navigation and scripts; it needs nothing from the portal beyond what a
 * caller posts to it.
 */
export function PreviewFrame({
  url,
  pending,
  error,
  device,
  className = '',
  frameRef,
}: {
  /** The minted consumer-site URL, once there is one. */
  url: string | undefined;
  pending: boolean;
  error: Error | null;
  device: PreviewDevice;
  /** Sizing of the frame's box (height is the caller's call). */
  className?: string;
  frameRef?: RefObject<HTMLIFrameElement | null>;
}) {
  return (
    <div
      className={[
        'flex justify-center overflow-hidden rounded-[var(--radius)] border-2 border-[#17151D] bg-slate-100',
        className,
      ].join(' ')}
    >
      {pending && <p className="self-center text-sm text-slate-500">Preparing the preview…</p>}
      {error && (
        <p className="max-w-md self-center px-4 text-center text-sm text-red-600">
          Couldn&apos;t open the preview: {error.message}
        </p>
      )}
      {url && (
        <iframe
          ref={frameRef}
          key={url}
          src={url}
          title="Customer preview"
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
          className={[
            'h-full border-0 bg-white',
            device === 'phone' ? 'w-[390px] max-w-full border-x-2 border-[#17151D]' : 'w-full',
          ].join(' ')}
        />
      )}
    </div>
  );
}
