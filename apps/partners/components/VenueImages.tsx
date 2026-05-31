'use client';

import { type ChangeEvent, useRef, useState } from 'react';
import {
  useDeleteVenueImage,
  useUploadVenueImage,
  useVenueImages,
  VENUE_IMAGE_MAX_BYTES,
  VENUE_IMAGE_TYPES,
} from '@/lib/api/queries';
import { Button } from '@/lib/ui';
import { ConfirmDialog } from './ConfirmDialog';

const MAX_IMAGES = 12;
const ACCEPT = VENUE_IMAGE_TYPES.join(',');

/**
 * Venue photo gallery + uploader for the partner portal. Uploads go straight
 * to R2 via presigned PUT (see useUploadVenueImage); reads use the public URL.
 */
export function VenueImages({ venueId }: { venueId: string }) {
  const { data: images, isLoading } = useVenueImages(venueId);
  const upload = useUploadVenueImage(venueId);
  const del = useDeleteVenueImage(venueId);

  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const count = images?.length ?? 0;
  const remaining = MAX_IMAGES - count;
  const busy = progress !== null;

  async function onFiles(e: ChangeEvent<HTMLInputElement>) {
    setError(null);
    const files = Array.from(e.target.files ?? []);
    if (fileInput.current) fileInput.current.value = ''; // allow re-picking the same file
    if (files.length === 0) return;
    if (files.length > remaining) {
      setError(`You can add ${remaining} more photo${remaining === 1 ? '' : 's'} (max ${MAX_IMAGES}).`);
      return;
    }

    // Upload sequentially so positions stay deterministic and errors are clear.
    setProgress({ done: 0, total: files.length });
    try {
      for (let i = 0; i < files.length; i++) {
        await upload.mutateAsync(files[i]!);
        setProgress({ done: i + 1, total: files.length });
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setProgress(null);
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded border border-gray-200 bg-white p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="font-medium">Photos</h2>
          <p className="text-xs text-gray-400">
            {count}/{MAX_IMAGES} · JPEG, PNG or WebP, up to {VENUE_IMAGE_MAX_BYTES / (1024 * 1024)} MB each
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          loading={busy}
          disabled={busy || remaining <= 0}
          onClick={() => fileInput.current?.click()}
        >
          {busy && progress ? `Uploading ${progress.done}/${progress.total}…` : 'Add photos'}
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept={ACCEPT}
          multiple
          hidden
          onChange={onFiles}
        />
      </div>

      {isLoading && <p className="text-sm text-gray-500">Loading…</p>}

      {!isLoading && count === 0 && (
        <p className="text-sm text-gray-500">
          No photos yet. The first photo becomes the cover image.
        </p>
      )}

      {count > 0 && (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
          {images!.map((img, i) => (
            <li
              key={img.id}
              className="group relative aspect-square overflow-hidden rounded border border-gray-200 bg-gray-50"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={img.url}
                alt="Venue photo"
                className="h-full w-full object-cover"
                loading="lazy"
              />
              {i === 0 && (
                <span className="absolute left-1.5 top-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">
                  Cover
                </span>
              )}
              <button
                type="button"
                onClick={() => setConfirmId(img.id)}
                className="absolute right-1.5 top-1.5 rounded bg-black/60 px-2 py-1 text-[10px] font-medium text-white opacity-0 transition-opacity hover:bg-red-600 group-hover:opacity-100"
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}

      <ConfirmDialog
        open={confirmId !== null}
        title="Delete photo?"
        message="This removes the photo from the venue and from storage. This can't be undone."
        confirmLabel="Delete"
        danger
        onConfirm={() => {
          if (confirmId) {
            del.mutate(confirmId, { onError: (e) => setError((e as Error).message) });
          }
        }}
        onClose={() => setConfirmId(null)}
      />
    </section>
  );
}
