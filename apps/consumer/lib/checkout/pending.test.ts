import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearPendingCheckout,
  loadVenueCart,
  saveVenueCart,
  savePendingCheckout,
  takePendingCheckout,
  type PendingCheckout,
} from './pending';
import type { CartSlot, CheckoutItem } from './types';

const ITEM: CheckoutItem = { kind: 'membership', membershipId: 'm1', title: 'Gold' };
const PENDING: PendingCheckout = { path: '/memberships/m1', item: ITEM, prefill: {} };

const SLOT: CartSlot = {
  id: 's1',
  arenaId: 'a1',
  arenaName: 'Court 1',
  startAt: '2026-09-01T10:00:00.000Z',
  endAt: '2026-09-01T11:00:00.000Z',
  pricePaise: 50000,
};

/** Minimal in-memory Storage; `onSet` lets a test make writes fail. */
function fakeStorage(onSet?: () => void): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => {
      onSet?.();
      map.set(k, v);
    },
  } as Storage;
}

function useStorage(storage: Storage | (() => never)): void {
  vi.stubGlobal('window', {
    get sessionStorage() {
      if (typeof storage === 'function') return storage();
      return storage;
    },
  });
}

describe('pending checkout storage', () => {
  beforeEach(() => {
    useStorage(fakeStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('round-trips a pending checkout on the path that saved it', () => {
    savePendingCheckout(PENDING);
    expect(takePendingCheckout('/memberships/m1')).toEqual(PENDING);
  });

  it('is destructive — a second read finds nothing', () => {
    savePendingCheckout(PENDING);
    takePendingCheckout('/memberships/m1');
    expect(takePendingCheckout('/memberships/m1')).toBeNull();
  });

  it('discards a checkout belonging to a different page', () => {
    savePendingCheckout(PENDING);
    expect(takePendingCheckout('/venues/v9')).toBeNull();
    // Cleared even on a mismatch, so a stale intent can't fire later.
    expect(takePendingCheckout('/memberships/m1')).toBeNull();
  });

  it('drops anything older than the max age', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T10:00:00.000Z'));
    savePendingCheckout(PENDING);

    // Just inside the window: still restored.
    vi.setSystemTime(new Date('2026-09-01T10:29:00.000Z'));
    expect(takePendingCheckout('/memberships/m1')).toEqual(PENDING);

    // Save afresh, then step past the window from *that* point.
    vi.setSystemTime(new Date('2026-09-01T11:00:00.000Z'));
    savePendingCheckout(PENDING);
    vi.setSystemTime(new Date('2026-09-01T11:31:00.000Z'));
    expect(takePendingCheckout('/memberships/m1')).toBeNull();
  });

  it('survives corrupt data under its key', () => {
    const storage = fakeStorage();
    storage.setItem('circls.pendingCheckout', 'not json{');
    useStorage(storage);
    expect(() => takePendingCheckout('/anything')).not.toThrow();
    expect(takePendingCheckout('/anything')).toBeNull();
  });

  it('clearPendingCheckout removes it', () => {
    savePendingCheckout(PENDING);
    clearPendingCheckout();
    expect(takePendingCheckout('/memberships/m1')).toBeNull();
  });
});

describe('venue cart storage', () => {
  beforeEach(() => {
    useStorage(fakeStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('round-trips a cart per venue', () => {
    saveVenueCart('v1', [SLOT]);
    expect(loadVenueCart('v1')).toEqual([SLOT]);
    // Carts are keyed by venue and don't leak into one another.
    expect(loadVenueCart('v2')).toEqual([]);
  });

  it('saving an empty cart clears the stored one', () => {
    saveVenueCart('v1', [SLOT]);
    saveVenueCart('v1', []);
    expect(loadVenueCart('v1')).toEqual([]);
  });

  it('returns an empty cart when nothing was saved', () => {
    expect(loadVenueCart('never-used')).toEqual([]);
  });
});

describe('when storage is unavailable', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not throw during SSR, where there is no window', () => {
    vi.stubGlobal('window', undefined);
    expect(() => savePendingCheckout(PENDING)).not.toThrow();
    expect(takePendingCheckout('/memberships/m1')).toBeNull();
    expect(loadVenueCart('v1')).toEqual([]);
  });

  it('does not throw when the browser blocks site data', () => {
    // Safari private browsing and blocked-storage settings throw on access
    // rather than returning null.
    useStorage(() => {
      throw new Error('SecurityError');
    });
    expect(() => savePendingCheckout(PENDING)).not.toThrow();
    expect(takePendingCheckout('/memberships/m1')).toBeNull();
    expect(() => saveVenueCart('v1', [SLOT])).not.toThrow();
    expect(loadVenueCart('v1')).toEqual([]);
  });

  it('does not throw when a write exceeds quota', () => {
    useStorage(
      fakeStorage(() => {
        throw new Error('QuotaExceededError');
      }),
    );
    expect(() => savePendingCheckout(PENDING)).not.toThrow();
    expect(() => saveVenueCart('v1', [SLOT])).not.toThrow();
  });
});
