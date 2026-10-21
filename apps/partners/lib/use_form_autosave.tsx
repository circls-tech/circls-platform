'use client';

import {
  Fragment,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useAuth } from '@/lib/firebase/auth_context';
import {
  autosaveAction,
  clearSavedForms,
  formAutosaveKey,
  localStore,
  readSavedForm,
  removeSavedForm,
  restoredValues,
  stableJson,
  trackAutosave,
  writeSavedForm,
} from '@/lib/form_autosave';

/*
 * A create form autosaves in two calls, because the copy has to be read
 * before the fields' useState calls and written after them:
 *
 *   const autosave = useFormAutosave('coupon-new', [tenantId], blankCoupon);
 *   const [code, setCode] = useState(autosave.initial.code);
 *   …
 *   useAutosave(autosave, { code, … });
 *
 * It sits inside a <FormAutosaveScope>, which "Start over" remounts blank,
 * and calls `autosave.clear()` once the form is saved for real and on Cancel.
 */

/** Typing is written at most this often; a pending write is flushed when the form unmounts or the page hides. */
const WRITE_EVERY_MS = 500;

const RestartContext = createContext<(() => void) | null>(null);

/**
 * Around a form that autosaves, so "Start over" can remount it: every field's
 * useState initialiser runs again, now with nothing to restore.
 */
export function FormAutosaveScope({ children }: { children: ReactNode }) {
  const [generation, setGeneration] = useState(0);
  const restart = useCallback(() => setGeneration((g) => g + 1), []);
  return (
    <RestartContext.Provider value={restart}>
      <Fragment key={generation}>{children}</Fragment>
    </RestartContext.Provider>
  );
}

export interface FormAutosave<T> {
  /** What each field starts as: the blank form, with the copy kept from an earlier visit laid over it. */
  initial: T;
  /** When the restored copy was last changed (epoch ms); null when nothing was restored. */
  restoredAt: number | null;
  /** Forget the copy and stop saving: the form was submitted, or cancelled. */
  clear: () => void;
  /** Forget the copy and remount the form blank. */
  startOver: () => void;
}

/** The autosave's own bookkeeping, kept off the public interface. */
interface Saver {
  key: string | null;
  blankJson: string;
  /** What storage holds for this form, as `stableJson`. */
  lastWritten: string;
  /** The form's values as of the last render. */
  latest: unknown;
  timer: ReturnType<typeof setTimeout> | null;
  /** Set once the copy is cleared here, in another tab or by signing out: nothing more is written. */
  stopped: boolean;
}

const SAVER = Symbol('saver');
type Handle<T> = FormAutosave<T> & { [SAVER]: Saver };

/** Expired copies are swept once per page load, not on every form. */
let swept = false;

function flush(s: Saver): void {
  if (s.timer !== null) {
    clearTimeout(s.timer);
    s.timer = null;
  }
  if (!s.key || s.stopped || s.latest === undefined) return;
  const json = stableJson(s.latest);
  const action = autosaveAction(json, s.lastWritten, s.blankJson);
  if (action === 'skip') return;
  s.lastWritten = json;
  if (action === 'remove') removeSavedForm(localStore(), s.key);
  else writeSavedForm(localStore(), s.key, json);
}

export function useFormAutosave<T extends object>(
  form: string,
  scope: ReadonlyArray<string | null | undefined>,
  /** The form with nothing typed (or as seeded, e.g. from the event being duplicated). Called once. */
  blank: () => T,
  /** Turns down a saved copy that no longer makes sense (it names something since removed). */
  accept?: (values: T) => boolean,
): FormAutosave<T> {
  const { user } = useAuth();
  const restart = useContext(RestartContext);
  // Read once, as the form mounts: the fields in state belong to what the
  // form was opened for, so a later scope change must not file them under
  // another key.
  const [opened] = useState(() => {
    const key = user ? formAutosaveKey(user.uid, form, scope) : null;
    const blankValues = blank();
    const saved = key ? readSavedForm<Partial<T>>(localStore(), key) : null;
    const restored = restoredValues(blankValues, saved?.values ?? null, accept);
    const blankJson = stableJson(blankValues);
    const saver: Saver = {
      key,
      blankJson,
      lastWritten: restored ? stableJson(restored) : blankJson,
      latest: undefined,
      timer: null,
      stopped: false,
    };
    return {
      initial: restored ?? blankValues,
      restoredAt: restored && saved ? saved.savedAt : null,
      rejected: Boolean(saved && !restored),
      saver,
    };
  });
  const s = opened.saver;

  useEffect(() => {
    if (opened.rejected && s.key) removeSavedForm(localStore(), s.key);
    if (!swept) {
      swept = true;
      clearSavedForms(localStore(), { expiredOnly: true });
    }
    return trackAutosave(s);
  }, [opened, s]);

  // Another tab ended this form (saved, cancelled, started over, signed
  // out): carrying on here would write back a copy of something finished.
  useEffect(() => {
    if (!s.key) return;
    function onStorage(e: StorageEvent) {
      if (e.key === null || (e.key === s.key && e.newValue === null)) s.stopped = true;
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [s]);

  const clear = useCallback(() => {
    s.stopped = true;
    flush(s);
    if (s.key) removeSavedForm(localStore(), s.key);
  }, [s]);

  const startOver = useCallback(() => {
    if (!restart) throw new Error('startOver needs a <FormAutosaveScope> around the form');
    clear();
    restart();
  }, [clear, restart]);

  return useMemo<Handle<T>>(
    () => ({
      initial: opened.initial,
      restoredAt: opened.restoredAt,
      clear,
      startOver,
      [SAVER]: s,
    }),
    [opened, clear, startOver, s],
  );
}

/** Keeps `values` (JSON-safe: no files) saved as they change. */
export function useAutosave<T>(autosave: FormAutosave<T>, values: T): void {
  const s = (autosave as Handle<T>)[SAVER];
  // Every render: note the values, and make sure a write is coming. The
  // serialising happens in the write, at most every WRITE_EVERY_MS.
  useEffect(() => {
    s.latest = values;
    if (s.timer === null && !s.stopped) s.timer = setTimeout(() => flush(s), WRITE_EVERY_MS);
  });
  useEffect(() => {
    function onHide() {
      if (document.visibilityState === 'hidden') flush(s);
    }
    function onPageHide() {
      flush(s);
    }
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onPageHide);
      // Leaving the page within a client navigation: write what's pending.
      flush(s);
    };
  }, [s]);
}
