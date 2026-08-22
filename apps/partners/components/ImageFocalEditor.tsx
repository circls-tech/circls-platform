'use client';

import { type PointerEvent as ReactPointerEvent, type KeyboardEvent, useEffect, useRef, useState } from 'react';
import type { FocalPoint } from '@/lib/api/queries';
import { Button, Modal } from '@/lib/ui';

/** Consumer listing cards render photos in a ~260×140 box (EventCard/VenueCard). */
const CARD_W = 260;
const CARD_H = 140;

/** Arrow-key nudge, in image-space fraction. */
const STEP = 0.02;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** CSS `object-position` for a focal point — the same maths the consumer uses. */
export function focalPosition(focal: FocalPoint): string {
  return `${focal.focalX * 100}% ${focal.focalY * 100}%`;
}

/**
 * Pick which part of a photo survives the consumer card crop.
 *
 * Listing cards are a fixed landscape box, so a portrait poster loses most of
 * its height. Rather than explain how CSS `object-position` maps percentages,
 * this shows the real 260×140 card next to the photo and updates it live —
 * partners drag until the preview looks right and never have to reason about
 * the maths.
 */
export function ImageFocalEditor({
  open,
  imageUrl,
  initialFocal,
  saving = false,
  onSave,
  onClose,
}: {
  open: boolean;
  imageUrl: string;
  initialFocal: FocalPoint;
  saving?: boolean;
  onSave: (focal: FocalPoint) => void;
  onClose: () => void;
}) {
  const [focal, setFocal] = useState<FocalPoint>(initialFocal);
  const [dragging, setDragging] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  // Re-seed whenever a different photo (or a saved value) is opened.
  useEffect(() => {
    if (open) setFocal(initialFocal);
  }, [open, initialFocal]);

  /** The box wraps the <img> exactly, so its rect IS image space. */
  function setFromPointer(e: ReactPointerEvent<HTMLDivElement>) {
    const el = boxRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    setFocal({
      focalX: clamp01((e.clientX - r.left) / r.width),
      focalY: clamp01((e.clientY - r.top) / r.height),
    });
  }

  /** Capture keeps a drag alive outside the box; a plain click still works
   *  without it, so never let a capture failure swallow the interaction. */
  function capture(el: HTMLDivElement, pointerId: number, on: boolean) {
    try {
      if (on) el.setPointerCapture(pointerId);
      else el.releasePointerCapture(pointerId);
    } catch {
      /* no active pointer to capture — ignore */
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const dx = e.key === 'ArrowLeft' ? -STEP : e.key === 'ArrowRight' ? STEP : 0;
    const dy = e.key === 'ArrowUp' ? -STEP : e.key === 'ArrowDown' ? STEP : 0;
    if (dx === 0 && dy === 0) return;
    e.preventDefault();
    setFocal((f) => ({
      focalX: clamp01(f.focalX + dx),
      focalY: clamp01(f.focalY + dy),
    }));
  }

  const isCentred = focal.focalX === 0.5 && focal.focalY === 0.5;

  return (
    <Modal open={open} onClose={onClose} title="Adjust crop" maxWidth="max-w-3xl">
      <div className="flex flex-col gap-5">
        <p className="text-sm text-slate-600">
          Drag the marker to the part of the photo that matters — the title of a poster, a
          face, your logo. The preview shows exactly how this photo appears in listings. The
          full photo is always shown uncropped on the public page.
        </p>

        <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
          {/* Editing surface: the box hugs the image so pointer coords map 1:1. */}
          <div
            ref={boxRef}
            role="application"
            aria-label="Photo crop focus. Use the arrow keys to move the focus marker."
            tabIndex={0}
            onKeyDown={onKeyDown}
            onPointerDown={(e) => {
              capture(e.currentTarget, e.pointerId, true);
              setDragging(true);
              setFromPointer(e);
            }}
            onPointerMove={(e) => {
              if (dragging) setFromPointer(e);
            }}
            onPointerUp={(e) => {
              capture(e.currentTarget, e.pointerId, false);
              setDragging(false);
            }}
            onPointerCancel={() => setDragging(false)}
            className="relative inline-block max-h-[55vh] cursor-crosshair touch-none self-start overflow-hidden rounded border border-gray-200 bg-slate-50 focus:outline-none focus:ring-2 focus:ring-brand-400"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={imageUrl}
              alt=""
              draggable={false}
              className="block max-h-[55vh] max-w-full select-none"
            />
            <span
              aria-hidden
              style={{ left: `${focal.focalX * 100}%`, top: `${focal.focalY * 100}%` }}
              className="pointer-events-none absolute h-7 w-7 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-brand-500/40 shadow-[0_0_0_1px_rgba(0,0,0,0.5)]"
            />
          </div>

          <div className="flex shrink-0 flex-col gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-[#475569]">
              Listing preview
            </span>
            <div
              style={{ width: CARD_W, height: CARD_H }}
              className="overflow-hidden rounded border border-gray-200 bg-slate-100"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={imageUrl}
                alt="Listing preview"
                style={{ objectPosition: focalPosition(focal) }}
                className="h-full w-full object-cover"
              />
            </div>
            <button
              type="button"
              disabled={isCentred}
              onClick={() => setFocal({ focalX: 0.5, focalY: 0.5 })}
              className="-ml-2 self-start rounded px-2 py-1 text-[13px] font-medium text-slate-900 hover:bg-slate-100 disabled:text-slate-400 disabled:hover:bg-transparent"
            >
              Reset to centre
            </button>
          </div>
        </div>

        <div className="flex justify-end gap-3">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" loading={saving} onClick={() => onSave(focal)}>
            Save crop
          </Button>
        </div>
      </div>
    </Modal>
  );
}
