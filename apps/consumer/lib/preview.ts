'use client';
import { useSearchParams } from 'next/navigation';

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
