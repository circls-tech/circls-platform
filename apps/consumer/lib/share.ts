import type { WishlistItemType } from '@/lib/api/types';

/** Where each kind of listing lives on circls.app. */
const LISTING_ROOT: Record<WishlistItemType, string> = {
  event: '/events',
  venue: '/venues',
  membership: '/memberships',
};

/**
 * A listing's canonical address on `origin` (e.g. `/events/<id>`). Built from
 * the id alone, never from the current URL, so its query string (a preview
 * token, say) can't ride along into someone's chat.
 */
export function listingUrl(origin: string, itemType: WishlistItemType, itemId: string): string {
  return `${origin}${LISTING_ROOT[itemType]}/${itemId}`;
}

/** A shared ticket's link on `origin`: the page where a friend adds it to their bookings. */
export function ticketLinkUrl(origin: string, token: string): string {
  return `${origin}/tickets/${encodeURIComponent(token)}`;
}

/**
 * Shares a link the way the device prefers: the native share sheet where the
 * browser has one (phones, Safari, Edge), the clipboard everywhere else.
 *
 * `copy` is what goes on the clipboard: the link by default, or the whole note
 * for a share whose text matters (a booking invite), which a bare link loses.
 *
 * Returns what happened so the caller can confirm it — a copied link needs a
 * "Link copied" note, a shared one does not (the sheet was the confirmation),
 * and a dismissed sheet needs nothing at all.
 */
export type ShareOutcome = 'shared' | 'copied' | 'dismissed' | 'unavailable';

export async function shareLink(
  data: { title: string; text?: string; url: string },
  { copy = data.url }: { copy?: string } = {},
): Promise<ShareOutcome> {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  // `canShare` is a stricter check than `share` alone: a desktop browser may
  // define share() yet refuse this payload, and we'd rather copy than throw.
  if (nav?.share && (!nav.canShare || nav.canShare(data))) {
    try {
      await nav.share(data);
      return 'shared';
    } catch (err) {
      // Closing the sheet rejects with AbortError; that is not a failure.
      if (err instanceof Error && err.name === 'AbortError') return 'dismissed';
      // Anything else (a sheet that failed to open, a permissions policy):
      // fall through to the clipboard so the tap still does something.
    }
  }
  if (nav?.clipboard?.writeText) {
    try {
      await nav.clipboard.writeText(copy);
      return 'copied';
    } catch {
      // Clipboard blocked (insecure context, denied permission).
    }
  }
  return 'unavailable';
}
