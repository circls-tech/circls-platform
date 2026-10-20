'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useCreateListingPreview, type ListingPreviewType } from '@/lib/api/preview';
import {
  SCRATCH_ID,
  SCRATCH_LISTING_MESSAGE,
  SCRATCH_READY_MESSAGE,
} from '@/lib/api/scratch_listing';
import { Button, Modal } from '@/lib/ui';
import { PREVIEW_NOUN, PreviewDeviceToggle, PreviewFrame, type PreviewDevice } from './PreviewFrame';

export interface ScratchPreviewProps {
  open: boolean;
  onClose: () => void;
  tenantId: string;
  type: ListingPreviewType;
  /** The listing as the form currently describes it (lib/api/scratch_listing). */
  listing: object;
  /** Photos picked on the form, not uploaded yet. */
  files: File[];
}

/** Wide screens dock the preview beside the form; narrower ones get a modal. */
function useDocked(): boolean {
  const [docked, setDocked] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1280px)');
    const sync = () => setDocked(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);
  return docked;
}

/**
 * The customer page for a listing that is not saved yet.
 *
 * The consumer site's own detail page is framed at its scratch id with a
 * token the API mints for this organisation; once the page says it is
 * listening, the form's current state is posted to it, and again on every
 * edit (debounced), so the partner sees the real page change as they type —
 * nothing is created until they press Create. Photos go across as Files; the
 * page shows them from object URLs.
 */
/** Docked pane widths per size, and the room the form leaves for them. The
 *  form reads the CSS variable (`xl:pr-[var(--scratch-preview-w)]`), set here
 *  while the pane is docked, so widening the pane pushes the form over. */
const DOCKED_WIDTH: Record<PreviewDevice, { pane: string; room: string }> = {
  phone: { pane: 'w-[440px]', room: '460px' },
  desktop: { pane: 'w-[900px]', room: '920px' },
};
export const SCRATCH_PREVIEW_ROOM_VAR = '--scratch-preview-w';

export function ScratchPreview({ open, onClose, tenantId, type, listing, files }: ScratchPreviewProps) {
  const docked = useDocked();
  // Phone first: that is where most customers will meet the listing.
  const [device, setDevice] = useState<PreviewDevice>('phone');
  const room = open && docked ? DOCKED_WIDTH[device].room : null;
  useEffect(() => {
    const root = document.documentElement;
    if (room) root.style.setProperty(SCRATCH_PREVIEW_ROOM_VAR, room);
    else root.style.removeProperty(SCRATCH_PREVIEW_ROOM_VAR);
    return () => {
      root.style.removeProperty(SCRATCH_PREVIEW_ROOM_VAR);
    };
  }, [room]);
  if (!open) return null;
  const pane = (
    <ScratchPreviewPane
      tenantId={tenantId}
      type={type}
      listing={listing}
      files={files}
      docked={docked}
      device={device}
      onDevice={setDevice}
      onClose={onClose}
    />
  );
  if (docked) {
    return (
      <aside
        aria-label="Customer preview"
        className={[
          'fixed bottom-4 right-4 top-20 z-30 flex max-w-[calc(100vw-2rem)] flex-col rounded-[var(--radius)] border-2 border-[#17151D] bg-white p-3 shadow-[4px_4px_0_#17151D]',
          DOCKED_WIDTH[device].pane,
        ].join(' ')}
      >
        {pane}
      </aside>
    );
  }
  return (
    <Modal open onClose={onClose} title="Preview as a customer" maxWidth="max-w-5xl">
      {pane}
    </Modal>
  );
}

function ScratchPreviewPane({
  tenantId,
  type,
  listing,
  files,
  docked,
  device,
  onDevice,
  onClose,
}: {
  tenantId: string;
  type: ListingPreviewType;
  listing: object;
  files: File[];
  docked: boolean;
  device: PreviewDevice;
  onDevice: (d: PreviewDevice) => void;
  onClose: () => void;
}) {
  const mint = useCreateListingPreview(tenantId);
  const { mutate } = mint;
  const frameRef = useRef<HTMLIFrameElement>(null);
  // Counted, not flagged: a frame that reloads (or comes back from a link)
  // announces itself again and must get the listing again.
  const [readySignals, setReadySignals] = useState(0);

  // One token per pane: minted when the preview opens.
  useEffect(() => {
    mutate({ type, id: SCRATCH_ID });
  }, [type, mutate]);

  const preview = mint.data;
  const origin = preview ? new URL(preview.url).origin : null;

  // The page announces it is listening; only our own frame is heard.
  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      if (!origin || ev.origin !== origin) return;
      if (ev.source !== frameRef.current?.contentWindow) return;
      if ((ev.data as { type?: unknown } | null)?.type === SCRATCH_READY_MESSAGE) {
        setReadySignals((n) => n + 1);
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [origin]);

  // The form rebuilds the listing on every render; only a change in what it
  // says (or in the picked files) is worth a post, a beat after typing stops.
  const signature = useMemo(
    () => JSON.stringify(listing) + '|' + files.map((f) => `${f.name}:${f.size}:${f.lastModified}`).join(','),
    [listing, files],
  );
  const latest = useRef({ listing, files });
  latest.current = { listing, files };
  useEffect(() => {
    if (readySignals === 0 || !origin) return;
    const target = frameRef.current?.contentWindow;
    if (!target) return;
    const id = window.setTimeout(() => {
      const { listing: l, images } = { listing: latest.current.listing, images: latest.current.files };
      target.postMessage({ type: SCRATCH_LISTING_MESSAGE, listing: l, images }, origin);
    }, 250);
    return () => window.clearTimeout(id);
  }, [readySignals, origin, signature]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-slate-600">
          {docked ? (
            <>This is the {PREVIEW_NOUN[type]}&apos;s page on the customer site. It follows the form as you type.</>
          ) : (
            <>
              This is the {PREVIEW_NOUN[type]}&apos;s page on the customer site, as it will appear once live.
              Nothing is saved until you press Create.
            </>
          )}
        </p>
        <div className="flex items-center gap-2">
          <PreviewDeviceToggle device={device} onChange={onDevice} />
          {docked && (
            <Button variant="secondary" size="sm" onClick={onClose}>
              Close
            </Button>
          )}
        </div>
      </div>

      <PreviewFrame
        url={preview?.url}
        pending={mint.isPending}
        error={mint.isError ? (mint.error as Error) : null}
        device={device}
        className={docked ? 'min-h-0 flex-1' : 'h-[70vh] min-h-[420px]'}
        frameRef={frameRef}
      />

      {!docked && (
        <div className="flex justify-end">
          <Button variant="secondary" size="sm" onClick={onClose}>
            Back to the form
          </Button>
        </div>
      )}
    </div>
  );
}
