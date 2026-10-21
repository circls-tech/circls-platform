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
  type RefObject,
} from 'react';
import { useAuth } from '@/lib/firebase/auth_context';
import {
  clearSavedForms,
  formAutosaveKey,
  localStore,
  readSavedForm,
  removeSavedForm,
  writeSavedForm,
} from '@/lib/form_autosave';

/*
 * A create form autosaves in two calls, because the copy has to be read
 * before the fields' useState calls and written after them:
 *
 *   const autosave = useFormAutosave<CouponFields>('coupon-new', [tenantId]);
 *   const [code, setCode] = useState(autosave.restored?.code ?? '');
 *   …
 *   useAutosave(autosave, { code, … });
 *
 * and sits inside a <FormAutosaveScope>, which "Start over" remounts blank.
 */

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
  /** The copy saved on an earlier visit, read once as the form mounted. Seed each field from it. */
  restored: T | null;
  /** When that copy was saved (epoch ms). */
  savedAt: number | null;
  /** Forget the copy and stop saving: the form was submitted, or cancelled. */
  clear: () => void;
  /** Forget the copy and remount the form blank. */
  startOver: () => void;
  key: string | null;
  stopped: RefObject<boolean>;
}

export function useFormAutosave<T>(
  form: string,
  scope: ReadonlyArray<string | null | undefined> = [],
): FormAutosave<T> {
  const { user } = useAuth();
  const restart = useContext(RestartContext);
  // Fixed at mount: the fields in state belong to what the form was opened
  // for, so a later scope change must not file them under another key.
  const [key] = useState(() => (user ? formAutosaveKey(user.uid, form, scope) : null));
  const [saved] = useState(() => {
    const store = localStore();
    clearSavedForms(store, { expiredOnly: true });
    return key ? readSavedForm<T>(store, key) : null;
  });
  const stopped = useRef(false);

  const clear = useCallback(() => {
    stopped.current = true;
    if (key) removeSavedForm(localStore(), key);
  }, [key]);

  const startOver = useCallback(() => {
    if (key) removeSavedForm(localStore(), key);
    if (restart) restart();
    else stopped.current = true;
  }, [key, restart]);

  return useMemo(
    () => ({
      restored: saved?.values ?? null,
      savedAt: saved?.savedAt ?? null,
      clear,
      startOver,
      key,
      stopped,
    }),
    [saved, clear, startOver, key],
  );
}

/** Saves `values` (JSON-safe: no files) whenever they change. */
export function useAutosave<T>(autosave: FormAutosave<T>, values: T): void {
  const json = JSON.stringify(values);
  // What a blank form opened with. Getting back to it (every field emptied
  // again) leaves nothing worth keeping, and opening a form without typing
  // must not leave a copy that greets the next visit.
  const [pristine] = useState(() => (autosave.restored ? null : json));
  const { key, stopped } = autosave;
  useEffect(() => {
    if (!key || stopped.current) return;
    if (json === pristine) removeSavedForm(localStore(), key);
    else writeSavedForm(localStore(), key, json);
  }, [key, stopped, json, pristine]);
}
