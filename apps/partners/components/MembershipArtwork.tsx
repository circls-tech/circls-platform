'use client';

import { type ChangeEvent, useRef, useState } from 'react';
import {
  useRemoveMembershipCover,
  useUploadMembershipCover,
} from '@/lib/api/memberships';
import { VENUE_IMAGE_MAX_BYTES, VENUE_IMAGE_TYPES } from '@/lib/api/queries';
import { Button } from '@/lib/ui';

const ACCEPT = VENUE_IMAGE_TYPES.join(',');

/**
 * Single cover-artwork uploader for a membership (PR #110). Mirrors the venue
 * image flow (presign → PUT → finalize). `coverUrl` is the current artwork (or
 * null); the list query is invalidated on change so it refreshes.
 */
export function MembershipArtwork({
  tenantId,
  membershipId,
  coverUrl,
}: {
  tenantId: string;
  membershipId: string;
  coverUrl: string | null;
}) {
  const upload = useUploadMembershipCover(tenantId);
  const remove = useRemoveMembershipCover(tenantId);
  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    setError(null);
    const file = e.target.files?.[0];
    if (fileInput.current) fileInput.current.value = '';
    if (!file) return;
    try {
      await upload.mutateAsync({ membershipId, file });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <label className="text-xs font-medium uppercase tracking-wide text-[#475569]">Artwork</label>
      <div className="flex items-center gap-3">
        <div className="flex h-16 w-24 items-center justify-center overflow-hidden rounded-[var(--radius)] border border-[#e5e7eb] bg-slate-50">
          {coverUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={coverUrl} alt="Membership artwork" className="h-full w-full object-cover" />
          ) : (
            <span className="text-[10px] text-slate-400">No artwork</span>
          )}
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            loading={upload.isPending}
            onClick={() => fileInput.current?.click()}
          >
            {coverUrl ? 'Replace' : 'Upload'}
          </Button>
          {coverUrl && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              loading={remove.isPending}
              onClick={() => remove.mutate(membershipId, { onError: (e) => setError((e as Error).message) })}
            >
              Remove
            </Button>
          )}
        </div>
        <input ref={fileInput} type="file" accept={ACCEPT} hidden onChange={onFile} />
      </div>
      <p className="text-xs text-slate-400">
        JPEG, PNG or WebP, up to {VENUE_IMAGE_MAX_BYTES / (1024 * 1024)} MB.
      </p>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
