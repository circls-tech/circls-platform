/**
 * The partner portal origin the API names for a scratch preview, or null
 * when it is missing or not a bare http(s) origin. A scratch page takes a
 * posted listing only from a parent frame on this origin (see preview.ts);
 * null means it never takes one.
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
