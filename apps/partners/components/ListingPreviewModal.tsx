'use client';

import { useEffect, useState } from 'react';
import { useCreateListingPreview, type ListingPreviewType } from '@/lib/api/preview';
import { Button, Modal } from '@/lib/ui';

const NOUN: Record<ListingPreviewType, string> = {
  venue: 'venue',
  event: 'event',
  membership: 'plan',
};

export interface ListingPreviewModalProps {
  open: boolean;
  onClose: () => void;
  tenantId: string;
  type: ListingPreviewType;
  id: string;
  /**
   * An action to take from inside the preview — "Submit for review" on a
   * draft event — so the partner confirms what customers will see before
   * sending it off. Omitted, the modal is a plain look.
   */
  confirm?: {
    label: string;
    onConfirm: () => void | Promise<void>;
    loading?: boolean;
    disabled?: boolean;
  };
}

/**
 * The listing as a customer will see it, framed from the consumer site in
 * preview mode (apps/consumer/lib/preview.ts). The page is the consumer
 * site's own, so what is shown here is what will go live — not a portal-side
 * imitation of it. Booking is turned off on that page while previewing.
 *
 * A fresh preview link is minted each time the modal opens; it expires on
 * its own, and "Open in new tab" carries the same link for a full-size look.
 */
export function ListingPreviewModal({
  open,
  onClose,
  tenantId,
  type,
  id,
  confirm,
}: ListingPreviewModalProps) {
  const mint = useCreateListingPreview(tenantId);
  const { mutate, reset } = mint;
  // Phone first: that is where most customers will meet the listing.
  const [device, setDevice] = useState<'phone' | 'desktop'>('phone');

  useEffect(() => {
    if (!open) {
      reset();
      return;
    }
    mutate({ type, id });
  }, [open, type, id, mutate, reset]);

  const preview = mint.data;

  return (
    <Modal open={open} onClose={onClose} title="Preview as a customer" maxWidth="max-w-5xl">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-slate-600">
            This is the {NOUN[type]}&apos;s page on the customer site, exactly as it will appear
            once live. Booking is turned off in the preview.
          </p>
          <div className="flex items-center gap-2">
            <div
              role="group"
              aria-label="Preview size"
              className="inline-flex rounded-md border border-slate-200 bg-white p-0.5"
            >
              {(['phone', 'desktop'] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setDevice(d)}
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
            {preview && (
              <a
                href={preview.url}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
              >
                Open in new tab ↗
              </a>
            )}
          </div>
        </div>

        <div className="flex h-[70vh] min-h-[420px] justify-center overflow-hidden rounded-[var(--radius)] border-2 border-[#17151D] bg-slate-100">
          {mint.isPending && (
            <p className="self-center text-sm text-slate-500">Preparing the preview…</p>
          )}
          {mint.isError && (
            <p className="max-w-md self-center px-4 text-center text-sm text-red-600">
              Couldn&apos;t open the preview: {(mint.error as Error).message}
            </p>
          )}
          {preview && (
            <iframe
              key={preview.url}
              src={preview.url}
              title="Customer preview"
              // The consumer site handles its own navigation and scripts; it
              // needs nothing from this page, and this page nothing from it.
              sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
              className={[
                'h-full border-0 bg-white',
                device === 'phone'
                  ? 'w-[390px] max-w-full border-x-2 border-[#17151D]'
                  : 'w-full',
              ].join(' ')}
            />
          )}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>
            {confirm ? 'Back' : 'Close'}
          </Button>
          {confirm && (
            <Button
              petal="#A7E3BF"
              size="sm"
              loading={confirm.loading ?? false}
              disabled={confirm.disabled ?? false}
              onClick={() => void confirm.onConfirm()}
            >
              {confirm.label}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
