'use client';

import type { CartSlot, CheckoutItem, CheckoutPrefill } from './types';

/**
 * Session-scoped storage for a checkout that was interrupted by sign-in.
 *
 * Opening checkout while signed out bounces the visitor to /login, which
 * unmounts the page they were buying from and takes its React state with it —
 * the venue cart, the ticket quantities they picked, the tier they chose. They
 * came back to an empty page and had to start again.
 *
 * sessionStorage is the right lifetime here: it survives the redirect but dies
 * with the tab, so a cart never outlives the visit that created it.
 */

const PENDING_KEY = 'circls.pendingCheckout';
const CART_PREFIX = 'circls.cart.';

/**
 * Anything older than this is dropped on read. Slot availability drifts while
 * someone is signing up, so restoring a stale cart promises seats we can't
 * honour.
 */
const MAX_AGE_MS = 30 * 60 * 1000;

export interface PendingCheckout {
  /** The page that opened checkout; it only resumes back on that same page. */
  path: string;
  item: CheckoutItem;
  prefill: CheckoutPrefill;
}

interface Stamped<T> {
  savedAt: number;
  value: T;
}

/**
 * sessionStorage throws rather than returning null in a few real situations —
 * Safari private browsing, and browsers configured to block site data — so
 * every access is wrapped. Losing a cart is a worse-but-tolerable outcome; a
 * thrown exception that blanks the page is not.
 */
function session(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function readStamped<T>(key: string): T | null {
  const store = session();
  if (!store) return null;
  try {
    const raw = store.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Stamped<T>;
    if (typeof parsed?.savedAt !== 'number' || Date.now() - parsed.savedAt > MAX_AGE_MS) {
      store.removeItem(key);
      return null;
    }
    return parsed.value;
  } catch {
    // Corrupt or foreign data under our key — drop it rather than trip over it.
    try {
      store.removeItem(key);
    } catch {
      /* nothing further we can do */
    }
    return null;
  }
}

function writeStamped<T>(key: string, value: T): void {
  const store = session();
  if (!store) return;
  try {
    store.setItem(key, JSON.stringify({ savedAt: Date.now(), value } satisfies Stamped<T>));
  } catch {
    /* quota or blocked storage — the cart just won't survive the redirect */
  }
}

function remove(key: string): void {
  const store = session();
  if (!store) return;
  try {
    store.removeItem(key);
  } catch {
    /* ignore */
  }
}

export function savePendingCheckout(pending: PendingCheckout): void {
  writeStamped(PENDING_KEY, pending);
}

/**
 * Returns the pending checkout only if it belongs to `path`, and clears it
 * either way. Reading is destructive on purpose: a resumed checkout must not
 * fire twice if the visitor navigates back to the page later in the session.
 */
export function takePendingCheckout(path: string): PendingCheckout | null {
  const pending = readStamped<PendingCheckout>(PENDING_KEY);
  if (!pending) return null;
  remove(PENDING_KEY);
  return pending.path === path ? pending : null;
}

export function clearPendingCheckout(): void {
  remove(PENDING_KEY);
}

export function saveVenueCart(venueId: string, slots: CartSlot[]): void {
  if (slots.length === 0) {
    remove(`${CART_PREFIX}${venueId}`);
    return;
  }
  writeStamped(`${CART_PREFIX}${venueId}`, slots);
}

export function loadVenueCart(venueId: string): CartSlot[] {
  const slots = readStamped<CartSlot[]>(`${CART_PREFIX}${venueId}`);
  return Array.isArray(slots) ? slots : [];
}

export function clearVenueCart(venueId: string): void {
  remove(`${CART_PREFIX}${venueId}`);
}
