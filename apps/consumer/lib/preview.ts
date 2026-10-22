'use client';
import { useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api/client';
import type { Brand, ImageRef } from '@/lib/api/types';
import { scratchMessageVerdict, trustedParentOrigin } from '@/lib/preview_origin';

/**
 * Listing preview mode.
 *
 * A partner (or the Circls reviewer about to approve their listing) opens a
 * detail page with `?preview=<token>` — a short-lived token the API minted
 * for exactly that listing. The page sends it to the API in the
 * `X-Circls-Preview` header (a header, not a query string, so it stays out of
 * the API's request logs), and the API honours it on the page's own reads, so
 * an unapproved event, plan or venue renders here as it will once live. The
 * page shows a preview banner in place of the site header and turns booking
 * off; nothing else about it changes, because the point is to see the real
 * thing. The partner and admin portals frame these pages in a modal.
 *
 * The token must be read from the URL, not from state: the page is opened
 * cold inside an iframe, and "open in a new tab" lands here the same way.
 */
export const PREVIEW_PARAM = 'preview';

/** The preview token on the current URL, or null when browsing normally.
 *  Callers must sit under a Suspense boundary (useSearchParams). */
export function usePreviewToken(): string | null {
  const params = useSearchParams();
  const token = params.get(PREVIEW_PARAM);
  return token && token.length > 0 ? token : null;
}

/** The request header the API reads a preview token from. */
export const PREVIEW_HEADER = 'X-Circls-Preview';

/** Request options carrying the preview token to the API, if there is one. */
export function previewInit(token: string | null | undefined): RequestInit {
  return token ? { headers: { [PREVIEW_HEADER]: token } } : {};
}

/** Whether the current document was opened in preview mode. For code that
 *  runs outside React's render (effects on providers), where useSearchParams
 *  is not available without a Suspense boundary. Client only; false on SSR. */
export function isPreviewDocument(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return Boolean(new URLSearchParams(window.location.search).get(PREVIEW_PARAM));
  } catch {
    return false;
  }
}

// ── Scratch previews ─────────────────────────────────────────────────────────

/**
 * The "listing id" of a scratch preview: a listing that is not saved yet. A
 * partner filling in a create form opens this page framed with a scratch
 * token (minted by the API for the type), and the form posts the listing as
 * it is being typed, so they see the real customer page before anything is
 * created. The token is verified with the API first; without it the page
 * renders nothing a parent frame sends.
 */
export const SCRATCH_ID = 'scratch';

/** postMessage protocol between the partner portal (parent) and this page. */
export const SCRATCH_READY_MESSAGE = 'circls:scratch-ready';
export const SCRATCH_LISTING_MESSAGE = 'circls:scratch-listing';

export interface ScratchListingMessage<T> {
  type: typeof SCRATCH_LISTING_MESSAGE;
  listing: T;
  /** Photos picked on the form, not uploaded anywhere yet; shown via object URLs. */
  images: File[];
}

/** `unavailable`: the token is good but the page cannot take the form's
 *  listing (the API named no partner portal origin, or the parent frame
 *  posted from another origin). */
export type ScratchStatus = 'verifying' | 'denied' | 'unavailable' | 'waiting' | 'ready';

/** Only https images may be pointed at from a posted listing (a logo, say). */
export function safeImageUrl(url: unknown): string | null {
  return typeof url === 'string' && /^https:\/\//i.test(url) ? url : null;
}

/**
 * Listen for the listing the parent frame posts, once the API confirms the
 * token is a scratch preview of `type`. A listing is taken only from the
 * parent frame, and only when that frame is the partner portal (the origin
 * the API names); one posted from any other origin is refused and the page
 * says the preview is unavailable. The listing comes back with its brand's
 * logo URL sanitised; picked photos arrive as Files and are handed back as
 * image refs on object URLs, revoked when replaced and on unmount.
 */
export function useScratchListing<T extends { brand: Brand }>(
  active: boolean,
  token: string | null,
  type: 'venue' | 'event' | 'membership',
): { status: ScratchStatus; listing: T | null; images: ImageRef[] } {
  const verify = useQuery({
    queryKey: ['scratch-preview', type, token],
    queryFn: () =>
      apiFetch<{ type: string; parentOrigin?: string }>(
        `/v1/consumer/previews/scratch?type=${type}`,
        previewInit(token),
      ),
    enabled: active && Boolean(token),
    retry: false,
    staleTime: Infinity,
  });
  const parentOrigin = verify.isSuccess ? trustedParentOrigin(verify.data.parentOrigin) : null;

  const [listing, setListing] = useState<T | null>(null);
  const [imageUrls, setImageUrls] = useState<string[]>([]);
  const [refused, setRefused] = useState(false);

  useEffect(() => {
    if (!active || !parentOrigin || typeof window === 'undefined' || window.parent === window) return;
    const origin = parentOrigin;
    function onMessage(ev: MessageEvent) {
      const verdict = scratchMessageVerdict(ev, window.parent, origin);
      if (verdict === 'refuse') setRefused(true);
      if (verdict !== 'accept') return;
      const data = ev.data as Partial<ScratchListingMessage<T>> | null;
      if (!data || data.type !== SCRATCH_LISTING_MESSAGE || !data.listing) return;
      const posted = data.listing;
      setListing({ ...posted, brand: { ...posted.brand, logoUrl: safeImageUrl(posted.brand?.logoUrl) } });
      const files = Array.isArray(data.images) ? data.images.filter((f) => f instanceof Blob) : [];
      setImageUrls((prev) => {
        prev.forEach((u) => URL.revokeObjectURL(u));
        return files.map((f) => URL.createObjectURL(f));
      });
    }
    window.addEventListener('message', onMessage);
    // Tell the form we are listening: it sends the listing on this, and again
    // on every edit. The ping carries no data, so any parent may hear it; a
    // parent on the wrong origin then posts, is refused, and the page says
    // so instead of waiting for a listing that never comes.
    window.parent.postMessage({ type: SCRATCH_READY_MESSAGE }, '*');
    return () => window.removeEventListener('message', onMessage);
  }, [active, parentOrigin]);

  // Revoke whatever is current on unmount only; replacements are revoked by
  // the setter above, so this never pulls a URL out from under a render.
  const urlsRef = useRef<string[]>([]);
  urlsRef.current = imageUrls;
  useEffect(() => () => urlsRef.current.forEach((u) => URL.revokeObjectURL(u)), []);

  const images: ImageRef[] = imageUrls.map((url, i) => ({
    url,
    position: i,
    width: null,
    height: null,
    focalX: 0.5,
    focalY: 0.5,
  }));

  const status: ScratchStatus = !active
    ? 'waiting'
    : verify.isError || !token
      ? 'denied'
      : verify.isPending
        ? 'verifying'
        : !parentOrigin || refused
          ? 'unavailable'
          : listing
            ? 'ready'
            : 'waiting';
  return { status, listing, images };
}
