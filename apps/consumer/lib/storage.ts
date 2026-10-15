/**
 * Guarded sessionStorage access, shared by everything that keeps per-tab
 * state (the interrupted checkout, the venue cart, the activity queue).
 *
 * sessionStorage throws rather than returning null in a few real situations:
 * Safari private browsing, browsers configured to block site data, and
 * server-side rendering where `window` does not exist. Every access is
 * wrapped, and a failure reads as "nothing stored". Losing a cart or a few
 * telemetry rows is tolerable; a thrown exception that blanks the page is not.
 */

export function sessionStore(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function sessionRead(key: string): string | null {
  const store = sessionStore();
  if (!store) return null;
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}

export function sessionWrite(key: string, value: string): void {
  const store = sessionStore();
  if (!store) return;
  try {
    store.setItem(key, value);
  } catch {
    /* quota or blocked storage — the value just won't survive */
  }
}

export function sessionRemove(key: string): void {
  const store = sessionStore();
  if (!store) return;
  try {
    store.removeItem(key);
  } catch {
    /* ignore */
  }
}
