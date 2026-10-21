/**
 * Form autosave: what a partner has typed into a create form, kept in this
 * browser so going Back, following a link or reloading the page doesn't wipe
 * it. Nothing here reaches the server; the listings' "Save draft" buttons do
 * that.
 *
 * Kept in localStorage rather than sessionStorage so it also survives a
 * closed tab, under a key naming the signed-in user, the form and what it
 * belongs to (organisation, venue…), for a week. Signing out clears every
 * form's copy, because reception desks share computers.
 *
 * localStorage throws rather than returning null in private browsing, with
 * site data blocked, and on the server. Every access is wrapped, and a
 * failure reads as "nothing saved": losing a copy is tolerable, a thrown
 * exception that blanks the form is not.
 *
 * A form whose fields change type should change its form name (`event-new`
 * → `event-new.2`), so a copy saved before the deploy is never read into the
 * new shape. Fields that are only added are fine: the blank form fills them.
 */

export const FORM_AUTOSAVE_PREFIX = 'circls.formAutosave:';
export const FORM_AUTOSAVE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface SavedForm<T> {
  values: T;
  /** Epoch ms of the last write. */
  savedAt: number;
}

export function formAutosaveKey(
  uid: string,
  form: string,
  scope: ReadonlyArray<string | null | undefined>,
): string {
  return FORM_AUTOSAVE_PREFIX + [uid, form, ...scope.map((s) => s ?? '')].join(':');
}

export function localStore(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readSavedForm<T>(
  store: Storage | null,
  key: string,
  now = Date.now(),
): SavedForm<T> | null {
  if (!store) return null;
  let raw: string | null;
  try {
    raw = store.getItem(key);
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SavedForm<T>> | null;
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.savedAt === 'number' &&
      parsed.values !== undefined &&
      now - parsed.savedAt < FORM_AUTOSAVE_TTL_MS
    ) {
      return { values: parsed.values as T, savedAt: parsed.savedAt };
    }
  } catch {
    /* truncated or not ours — dropped below */
  }
  removeSavedForm(store, key);
  return null;
}

/** `valuesJson` is already serialised: the caller compares it to decide whether to write at all (`autosaveAction`). */
export function writeSavedForm(
  store: Storage | null,
  key: string,
  valuesJson: string,
  now = Date.now(),
): void {
  if (!store) return;
  try {
    store.setItem(key, `{"savedAt":${now},"values":${valuesJson}}`);
  } catch {
    /* quota or blocked storage — the copy just won't survive */
  }
}

export function removeSavedForm(store: Storage | null, key: string): void {
  if (!store) return;
  try {
    store.removeItem(key);
  } catch {
    /* ignore */
  }
}

/** The autosaves running in this page, so clearing every copy can stop them too. */
const running = new Set<{ stopped: boolean }>();

/** Registers a running autosave; returns its unregister. */
export function trackAutosave(saver: { stopped: boolean }): () => void {
  running.add(saver);
  return () => running.delete(saver);
}

/**
 * Every form's copy (on sign-out), or only those past their week. Clearing
 * every copy also stops the autosaves running in this page, or a write still
 * pending would put one back.
 */
export function clearSavedForms(
  store: Storage | null,
  opts: { expiredOnly?: boolean; now?: number } = {},
): void {
  if (!opts.expiredOnly) for (const saver of running) saver.stopped = true;
  if (!store) return;
  const now = opts.now ?? Date.now();
  try {
    const keys: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k?.startsWith(FORM_AUTOSAVE_PREFIX)) keys.push(k);
    }
    for (const k of keys) {
      // readSavedForm drops an expired or unreadable copy as it goes.
      if (opts.expiredOnly) readSavedForm(store, k, now);
      else removeSavedForm(store, k);
    }
  } catch {
    /* ignore */
  }
}

/**
 * JSON with every object's keys sorted, so two values with the same fields
 * compare equal however their objects were built.
 */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, (v as Record<string, unknown>)[k]]),
        )
      : v,
  );
}

/**
 * The form's starting values from a saved copy: the blank form with the
 * copy's fields laid over it (so a field added since it was saved still gets
 * its default). Null when there is no copy, or `accept` turns it down
 * (it names something no longer there).
 */
export function restoredValues<T extends object>(
  blank: T,
  saved: Partial<T> | null,
  accept?: (values: T) => boolean,
): T | null {
  if (!saved) return null;
  const values = { ...blank, ...saved };
  return accept && !accept(values) ? null : values;
}

/**
 * What an autosave flush does with the form as it stands (`json`), given what
 * storage already holds (`lastWritten`) and the blank form (`blankJson`).
 * Back to blank means nothing worth keeping.
 */
export function autosaveAction(
  json: string,
  lastWritten: string,
  blankJson: string,
): 'skip' | 'remove' | 'write' {
  if (json === lastWritten) return 'skip';
  return json === blankJson ? 'remove' : 'write';
}

/** "a moment ago", "5 minutes ago", "3 hours ago", "yesterday", "2 days ago". */
export function savedAgo(savedAt: number, now = Date.now()): string {
  const minutes = Math.floor((now - savedAt) / 60_000);
  if (minutes < 1) return 'a moment ago';
  if (minutes < 60) return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}
