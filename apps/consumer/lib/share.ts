/**
 * Shares a link the way the device prefers: the native share sheet where the
 * browser has one (phones, Safari, Edge), the clipboard everywhere else.
 *
 * Returns what happened so the caller can confirm it — a copied link needs a
 * "Link copied" note, a shared one does not (the sheet was the confirmation),
 * and a dismissed sheet needs nothing at all.
 */
export type ShareOutcome = 'shared' | 'copied' | 'dismissed' | 'unavailable';

export async function shareLink(data: { title: string; text?: string; url: string }): Promise<ShareOutcome> {
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
      await nav.clipboard.writeText(data.url);
      return 'copied';
    } catch {
      // Clipboard blocked (insecure context, denied permission).
    }
  }
  return 'unavailable';
}
