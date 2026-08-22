'use client';

import { type ChangeEvent, useRef, useState } from 'react';
import { type FocalPoint, VENUE_IMAGE_MAX_BYTES, VENUE_IMAGE_TYPES } from '@/lib/api/queries';
import { Button } from '@/lib/ui';
import { ConfirmDialog } from './ConfirmDialog';
import { focalPosition, ImageFocalEditor } from './ImageFocalEditor';

const ACCEPT = VENUE_IMAGE_TYPES.join(',');

/** The subset of a venue/event image row this editor needs. */
export interface GalleryImage {
  id: string;
  url: string;
  focalX: number;
  focalY: number;
}

/** Move one item within a list, returning a new array. */
function move<T>(list: T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

/**
 * Photo gallery manager shared by venues and events — upload, order, choose the
 * cover, adjust each photo's crop, delete.
 *
 * Thumbnails are deliberately rendered at the CONSUMER card's aspect ratio with
 * the photo's own focal point applied, not as neat squares. Partners were
 * uploading portrait posters and only discovering on the public listing that
 * the card crop had cut the title off; a square preview hid the very problem it
 * was supposed to reveal.
 */
export function ImageGalleryEditor({
  subject,
  images,
  isLoading,
  max,
  hint,
  uploadFile,
  deleteImage,
  reorder,
  setFocal,
}: {
  subject: 'venue' | 'event';
  images: GalleryImage[] | undefined;
  isLoading: boolean;
  max: number;
  /** Extra clause appended to the counts line (e.g. the series-gallery note). */
  hint?: string;
  uploadFile: (file: File) => Promise<unknown>;
  deleteImage: (imageId: string) => Promise<unknown>;
  reorder: (imageIds: string[]) => Promise<unknown>;
  setFocal: (imageId: string, focal: FocalPoint) => Promise<unknown>;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [cropId, setCropId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const list = images ?? [];
  const count = list.length;
  const remaining = max - count;
  const uploading = progress !== null;
  const busy = uploading || pending;
  const cropping = list.find((img) => img.id === cropId) ?? null;

  async function onFiles(e: ChangeEvent<HTMLInputElement>) {
    setError(null);
    const files = Array.from(e.target.files ?? []);
    if (fileInput.current) fileInput.current.value = ''; // allow re-picking the same file
    if (files.length === 0) return;
    if (files.length > remaining) {
      setError(`You can add ${remaining} more photo${remaining === 1 ? '' : 's'} (max ${max}).`);
      return;
    }

    // Upload sequentially so positions stay deterministic and errors are clear.
    setProgress({ done: 0, total: files.length });
    try {
      for (let i = 0; i < files.length; i++) {
        await uploadFile(files[i]!);
        setProgress({ done: i + 1, total: files.length });
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setProgress(null);
    }
  }

  /** The order endpoint takes the whole gallery, so send the reordered ids. */
  async function applyOrder(nextIds: string[]) {
    setError(null);
    setPending(true);
    try {
      await reorder(nextIds);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(false);
    }
  }

  async function saveFocal(imageId: string, focal: FocalPoint) {
    setError(null);
    setPending(true);
    try {
      await setFocal(imageId, focal);
      setCropId(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(false);
    }
  }

  const ids = list.map((img) => img.id);

  return (
    <section className="flex flex-col gap-3 rounded border border-gray-200 bg-white p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="font-medium">Photos</h2>
          <p className="text-xs text-gray-400">
            {count}/{max} &middot; JPEG, PNG or WebP, up to{' '}
            {VENUE_IMAGE_MAX_BYTES / (1024 * 1024)} MB each &middot; the first is the cover
            {hint ? ` · ${hint}` : ''}
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          loading={uploading}
          disabled={busy || remaining <= 0}
          onClick={() => fileInput.current?.click()}
        >
          {uploading && progress ? `Uploading ${progress.done}/${progress.total}…` : 'Add photos'}
        </Button>
        <input ref={fileInput} type="file" accept={ACCEPT} multiple hidden onChange={onFiles} />
      </div>

      {isLoading && <p className="text-sm text-gray-500">Loading&hellip;</p>}

      {!isLoading && count === 0 && (
        <p className="text-sm text-gray-500">
          No photos yet. The first photo becomes the {subject}&rsquo;s cover image.
        </p>
      )}

      {count > 0 && (
        <>
          <p className="text-xs text-gray-500">
            Each thumbnail shows how that photo is cropped in listings. If something important is
            cut off, use <span className="font-medium">Crop</span> to choose what stays in frame.
            The full photo is always shown uncropped on the public page.
          </p>
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {list.map((img, i) => (
              <li key={img.id} className="flex flex-col gap-1.5">
                <div className="relative aspect-[13/7] overflow-hidden rounded border border-gray-200 bg-gray-50">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={img.url}
                    alt={`${subject} photo ${i + 1}`}
                    loading="lazy"
                    style={{ objectPosition: focalPosition(img) }}
                    className="h-full w-full object-cover"
                  />
                  {i === 0 && (
                    <span className="absolute left-1.5 top-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">
                      Cover
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-x-1 gap-y-1 text-[13px]">
                  <button
                    type="button"
                    disabled={busy || i === 0}
                    aria-label={`Move photo ${i + 1} earlier`}
                    onClick={() => void applyOrder(move(ids, i, i - 1))}
                    className="rounded px-2 py-1 font-medium text-slate-600 hover:bg-slate-100 disabled:text-slate-300 disabled:hover:bg-transparent"
                  >
                    &larr;
                  </button>
                  <button
                    type="button"
                    disabled={busy || i === count - 1}
                    aria-label={`Move photo ${i + 1} later`}
                    onClick={() => void applyOrder(move(ids, i, i + 1))}
                    className="rounded px-2 py-1 font-medium text-slate-600 hover:bg-slate-100 disabled:text-slate-300 disabled:hover:bg-transparent"
                  >
                    &rarr;
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setCropId(img.id)}
                    className="rounded px-2 py-1 font-medium text-slate-900 hover:bg-slate-100 disabled:text-slate-400 disabled:hover:bg-transparent"
                  >
                    Crop
                  </button>
                  {i > 0 && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void applyOrder([img.id, ...ids.filter((id) => id !== img.id)])}
                      className="rounded px-2 py-1 font-medium text-slate-900 hover:bg-slate-100 disabled:text-slate-400 disabled:hover:bg-transparent"
                    >
                      Make cover
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setConfirmId(img.id)}
                    className="ml-auto rounded px-2 py-1 font-medium text-red-600 hover:bg-red-50 disabled:text-slate-400 disabled:hover:bg-transparent"
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}

      {cropping && (
        <ImageFocalEditor
          open
          imageUrl={cropping.url}
          initialFocal={{ focalX: cropping.focalX, focalY: cropping.focalY }}
          saving={pending}
          onSave={(focal) => void saveFocal(cropping.id, focal)}
          onClose={() => setCropId(null)}
        />
      )}

      <ConfirmDialog
        open={confirmId !== null}
        title="Delete photo?"
        message={`This removes the photo from the ${subject} and from storage. This can't be undone.`}
        confirmLabel="Delete"
        danger
        onConfirm={() => {
          if (confirmId) {
            void deleteImage(confirmId).catch((e) => setError((e as Error).message));
          }
        }}
        onClose={() => setConfirmId(null)}
      />
    </section>
  );
}
