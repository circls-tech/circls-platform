// Who a scratch preview page (see preview.ts) takes a posted listing from.
// Kept apart from preview.ts, which pulls in the app's API client and
// Firebase, so these checks can be unit tested on their own.

/**
 * The partner portal origin the API names for a scratch preview, or null
 * when it is missing or not a bare http(s) origin. A scratch page takes a
 * posted listing only from a parent frame on this origin; null means it
 * never takes one.
 */
export function trustedParentOrigin(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin === value ? value : null;
  } catch {
    return null;
  }
}

/**
 * What a scratch page does with a message event: `accept` the listing in it
 * (the parent frame, on the partner portal's origin), `ignore` it (not from
 * the parent frame at all), or `refuse` it (the parent frame, but on another
 * origin: an outside site framing the page, or an environment whose partner
 * portal is not where the API says it is).
 */
export type ScratchMessageVerdict = 'accept' | 'ignore' | 'refuse';

export function scratchMessageVerdict(
  ev: { source: unknown; origin: string },
  parent: unknown,
  parentOrigin: string,
): ScratchMessageVerdict {
  if (ev.source !== parent) return 'ignore';
  return ev.origin === parentOrigin ? 'accept' : 'refuse';
}
