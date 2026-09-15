/**
 * How many pages deep into *our own* app the visitor currently is.
 *
 * `window.history.length` can't answer this: it counts entries from every
 * origin the tab has visited, so it reads > 1 for someone who arrived from a
 * search result and has nowhere in circls to go back to. Trusting it meant
 * "← Back" called `router.back()`, which refuses to traverse a cross-origin
 * entry — so the button did nothing at all, the dead end it exists to avoid.
 *
 * So we count our own navigations instead. The counter is per-tab and resets on
 * every fresh document load, which is exactly when a visit begins.
 */

const KEY = 'circls:nav-depth';

/**
 * sessionStorage throws rather than returning null in a few real situations —
 * Safari private browsing, and browsers configured to block site data — so
 * every access is wrapped. A missing counter just means Back falls back to its
 * href, which is the safe direction to fail in.
 */
function session(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function read(): number {
  const store = session();
  if (!store) return 0;
  try {
    const raw = store.getItem(KEY);
    if (raw === null) return 0;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function write(depth: number): void {
  const store = session();
  if (!store) return;
  try {
    store.setItem(KEY, String(Math.max(0, depth)));
  } catch {
    // Nothing to do — see the note on session().
  }
}

/** A new document loaded, so this page is where the visit starts. */
export function beginVisit(): void {
  write(0);
}

/** Moved forward within the app — one more page we can return through. */
export function recordForward(): void {
  write(read() + 1);
}

/** Went back within the app, so we're one page shallower. */
export function recordBack(): void {
  write(read() - 1);
}

/** Whether `router.back()` will land on another circls page. */
export function canGoBack(): boolean {
  return read() > 0;
}
