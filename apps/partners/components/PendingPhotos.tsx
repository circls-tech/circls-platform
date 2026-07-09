'use client';

import { type ChangeEvent, useEffect, useRef, useState } from 'react';
import { VENUE_IMAGE_MAX_BYTES, VENUE_IMAGE_TYPES } from '@/lib/api/queries';
import { Button } from '@/lib/ui';

const ACCEPT = VENUE_IMAGE_TYPES.join(',');

/** A photo picked on a create form, held locally until the entity exists. */
export interface PendingPhoto {
  id: string;
  file: File;
  /** Object URL for the preview thumbnail (revoked on removal/unmount). */
  previewUrl: string;
}

/**
 * Photo picker for CREATE forms. Image endpoints need an entity id, so files
 * selected here are just held (with previews) and uploaded by the caller right
 * after creation succeeds. Mirrors the EventImages/MembershipArtwork look and
 * enforces the same type/size rules client-side.
 */
export function PendingPhotosPicker({
  photos,
  onChange,
  max = 12,
  title = 'Photos',
  hint,
}: {
  photos: PendingPhoto[];
  onChange: (photos: PendingPhoto[]) => void;
  /** Max photos; pass 1 for single-cover pickers (e.g. membership artwork). */
  max?: number;
  title?: string;
  hint?: string;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const single = max === 1;
  const remaining = max - photos.length;

  // Revoke every preview URL on unmount only (photos removed individually are
  // revoked in remove()); [] deps + ref keep this from firing per render.
  const photosRef = useRef(photos);
  photosRef.current = photos;
  useEffect(
    () => () => photosRef.current.forEach((p) => URL.revokeObjectURL(p.previewUrl)),
    [],
  );

  function onFiles(e: ChangeEvent<HTMLInputElement>) {
    setError(null);
    const files = Array.from(e.target.files ?? []);
    if (fileInput.current) fileInput.current.value = '';
    if (files.length === 0) return;
    if (!single && files.length > remaining) {
      setError(`You can add ${remaining} more photo${remaining === 1 ? '' : 's'} (max ${max}).`);
      return;
    }
    for (const f of files) {
      if (!VENUE_IMAGE_TYPES.includes(f.type)) {
        setError('Use JPEG, PNG, or WebP images.');
        return;
      }
      if (f.size > VENUE_IMAGE_MAX_BYTES) {
        setError(`"${f.name}" is too large (max ${VENUE_IMAGE_MAX_BYTES / (1024 * 1024)} MB).`);
        return;
      }
    }
    const picked = files.map((file) => ({
      id: crypto.randomUUID(),
      file,
      previewUrl: URL.createObjectURL(file),
    }));
    if (single) {
      photos.forEach((p) => URL.revokeObjectURL(p.previewUrl));
      onChange(picked.slice(0, 1));
    } else {
      onChange([...photos, ...picked]);
    }
  }

  function remove(id: string) {
    const target = photos.find((p) => p.id === id);
    if (target) URL.revokeObjectURL(target.previewUrl);
    onChange(photos.filter((p) => p.id !== id));
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <div>
          <label className="text-xs font-medium uppercase tracking-wide text-[#475569]">{title}</label>
          <p className="text-xs text-gray-400">
            {hint ??
              `${photos.length}/${max} · JPEG, PNG or WebP, up to ${VENUE_IMAGE_MAX_BYTES / (1024 * 1024)} MB each${single ? '' : ' · first is the cover'} · uploaded on create`}
          </p>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={!single && remaining <= 0}
          onClick={() => fileInput.current?.click()}
        >
          {single ? (photos.length ? 'Replace photo' : 'Add photo') : 'Add photos'}
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept={ACCEPT}
          multiple={!single}
          hidden
          onChange={onFiles}
        />
      </div>

      {photos.length > 0 && (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
          {photos.map((p, i) => (
            <li
              key={p.id}
              className="group relative aspect-square overflow-hidden rounded border border-gray-200 bg-gray-50"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={p.previewUrl} alt="Selected photo" className="h-full w-full object-cover" />
              {!single && i === 0 && (
                <span className="absolute left-1.5 top-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">
                  Cover
                </span>
              )}
              <button
                type="button"
                onClick={() => remove(p.id)}
                className="absolute right-1.5 top-1.5 rounded bg-black/60 px-2 py-1 text-[10px] font-medium text-white opacity-0 transition-opacity hover:bg-red-600 group-hover:opacity-100"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
