import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  beginVisit,
  canGoBack,
  consumeReplace,
  markReplace,
  recordBack,
  recordForward,
} from './history_depth';

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

describe('in-app navigation depth', () => {
  beforeEach(() => {
    useStorage(fakeStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('will not go back from the page a visit started on', () => {
    beginVisit();
    expect(canGoBack()).toBe(false);
  });

  it('goes back once the visitor has moved forward', () => {
    beginVisit();
    recordForward();
    expect(canGoBack()).toBe(true);
  });

  // The bug this module exists for: arriving from a search result leaves
  // window.history.length > 1, but there is no circls page behind us.
  it('stays at the surface for a visit that begins on a deep link', () => {
    beginVisit();
    expect(canGoBack()).toBe(false);
    beginVisit();
    expect(canGoBack()).toBe(false);
  });

  // Going back used to raise the count, so a second Back would try to step off
  // the front of our own history and land nowhere.
  it('unwinds, so Back is offered exactly as often as there are pages behind', () => {
    beginVisit();
    recordForward();
    recordForward();
    expect(canGoBack()).toBe(true);

    recordBack();
    expect(canGoBack()).toBe(true);

    recordBack();
    expect(canGoBack()).toBe(false);
  });

  it('never goes negative, so an extra back does not bank credit', () => {
    beginVisit();
    recordBack();
    recordBack();
    expect(canGoBack()).toBe(false);

    recordForward();
    expect(canGoBack()).toBe(true);
  });

  // Back on a top-level tab replaces the entry rather than pushing one, so the
  // depth must not grow with it: a counter that outruns our own history ends
  // with router.back() called when nothing of ours is behind — an inert button.
  it('recognises the landing of a replace, so the tracker can skip counting it', () => {
    markReplace('/');
    expect(consumeReplace('/')).toBe(true);
  });

  it('matches a marked replace on the path alone, ignoring query and hash', () => {
    markReplace('/venues?city=bengaluru#list');
    expect(consumeReplace('/venues')).toBe(true);
  });

  it('does not let a replace that never landed swallow a later forward', () => {
    beginVisit();
    markReplace('/');
    // The visitor went somewhere else instead, so the mark does not apply —
    // and is spent, rather than lying in wait for the next navigation.
    expect(consumeReplace('/events')).toBe(false);
    expect(consumeReplace('/')).toBe(false);
    recordForward();
    expect(canGoBack()).toBe(true);
  });

  it('treats a corrupted counter as the start of the visit', () => {
    const store = fakeStorage();
    store.setItem('circls:nav-depth', 'not-a-number');
    useStorage(store);
    expect(canGoBack()).toBe(false);
  });

  it('reports no history when storage is unavailable', () => {
    useStorage(() => {
      throw new Error('SecurityError: site data blocked');
    });
    expect(canGoBack()).toBe(false);
    // Recording must not throw either — the page still has to render.
    expect(() => {
      beginVisit();
      recordForward();
    }).not.toThrow();
  });

  it('survives a storage that refuses writes', () => {
    useStorage(
      fakeStorage(() => {
        throw new Error('QuotaExceededError');
      }),
    );
    expect(() => recordForward()).not.toThrow();
    expect(canGoBack()).toBe(false);
  });

  it('reports no history during server rendering', () => {
    vi.stubGlobal('window', undefined);
    expect(canGoBack()).toBe(false);
  });
});
