/**
 * The only post-login destination we ever follow: a path on this site.
 *
 * `/login?redirect=…` is attacker-controllable — it is just a link — and the
 * app router hands anything off-origin, `javascript:` URLs included, straight
 * to `location.replace`. So the value must be an absolute path on this
 * origin: exactly one leading slash (two is scheme-relative, `//evil.example`)
 * and not a backslash after it (browsers read `/\evil.example` the same way).
 * Anything else, including control characters that URL parsers silently
 * strip, falls back to the home page.
 */
export function safeRedirectPath(raw: string | null | undefined, fallback = '/'): string {
  if (typeof raw !== 'string') return fallback;
  if (!/^\/(?![/\\])/.test(raw)) return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\s]/.test(raw)) return fallback;
  try {
    // Resolve against a fixed origin so the check is identical in tests and
    // in the browser: a genuine path can only ever land on that origin.
    const url = new URL(raw, 'https://circls.invalid');
    if (url.origin !== 'https://circls.invalid') return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}
