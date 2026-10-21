import { describe, expect, it } from 'vitest';
import {
  FORM_AUTOSAVE_TTL_MS,
  clearSavedForms,
  formAutosaveKey,
  readSavedForm,
  savedAgo,
  writeSavedForm,
} from './form_autosave';

/** A Map-backed Storage, so the tests run in the plain node environment. */
function memoryStore(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
  };
}

const T0 = 1_800_000_000_000;

describe('form autosave storage', () => {
  it('keys by user, form and scope', () => {
    expect(formAutosaveKey('u1', 'event-new', ['t1', null])).toBe('circls.formAutosave:u1:event-new:t1:');
    expect(formAutosaveKey('u1', 'event-new', ['t1'])).not.toBe(formAutosaveKey('u2', 'event-new', ['t1']));
  });

  it('reads back what was written', () => {
    const store = memoryStore();
    const key = formAutosaveKey('u1', 'coupon-new', ['t1']);
    writeSavedForm(store, key, JSON.stringify({ code: 'SUMMER10', tiers: [{ name: 'A' }] }), T0);
    expect(readSavedForm(store, key, T0 + 1000)).toEqual({
      values: { code: 'SUMMER10', tiers: [{ name: 'A' }] },
      savedAt: T0,
    });
  });

  it('drops a copy a week old', () => {
    const store = memoryStore();
    const key = formAutosaveKey('u1', 'coupon-new', ['t1']);
    writeSavedForm(store, key, '{"code":"X"}', T0);
    expect(readSavedForm(store, key, T0 + FORM_AUTOSAVE_TTL_MS)).toBeNull();
    expect(store.getItem(key)).toBeNull();
  });

  it('drops an unreadable copy instead of throwing', () => {
    const store = memoryStore();
    store.setItem('circls.formAutosave:u1:x', '{"savedAt":');
    store.setItem('circls.formAutosave:u1:y', '"just a string"');
    expect(readSavedForm(store, 'circls.formAutosave:u1:x', T0)).toBeNull();
    expect(readSavedForm(store, 'circls.formAutosave:u1:y', T0)).toBeNull();
    expect(store.length).toBe(0);
  });

  it('treats missing or throwing storage as nothing saved', () => {
    expect(readSavedForm(null, 'k')).toBeNull();
    const throwing = {
      ...memoryStore(),
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    } as Storage;
    expect(readSavedForm(throwing, 'k')).toBeNull();
    expect(() => writeSavedForm(throwing, 'k', '{}')).not.toThrow();
  });

  it('clears every form copy on sign-out, and leaves other keys alone', () => {
    const store = memoryStore();
    store.setItem('circls.activeTenantId', 't1');
    writeSavedForm(store, formAutosaveKey('u1', 'a', []), '1', T0);
    writeSavedForm(store, formAutosaveKey('u1', 'b', []), '2', T0);
    clearSavedForms(store);
    expect(store.length).toBe(1);
    expect(store.getItem('circls.activeTenantId')).toBe('t1');
  });

  it('prunes only expired copies when asked', () => {
    const store = memoryStore();
    writeSavedForm(store, formAutosaveKey('u1', 'old', []), '1', T0);
    writeSavedForm(store, formAutosaveKey('u1', 'new', []), '2', T0 + FORM_AUTOSAVE_TTL_MS);
    clearSavedForms(store, { expiredOnly: true, now: T0 + FORM_AUTOSAVE_TTL_MS + 1 });
    expect(store.getItem(formAutosaveKey('u1', 'old', []))).toBeNull();
    expect(store.getItem(formAutosaveKey('u1', 'new', []))).not.toBeNull();
  });

  it('says how long ago a copy was saved', () => {
    expect(savedAgo(T0, T0 + 30_000)).toBe('a moment ago');
    expect(savedAgo(T0, T0 + 60_000)).toBe('1 minute ago');
    expect(savedAgo(T0, T0 + 5 * 60_000)).toBe('5 minutes ago');
    expect(savedAgo(T0, T0 + 3 * 3_600_000)).toBe('3 hours ago');
    expect(savedAgo(T0, T0 + 30 * 3_600_000)).toBe('yesterday');
    expect(savedAgo(T0, T0 + 3 * 86_400_000)).toBe('3 days ago');
  });
});
