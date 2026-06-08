'use client';
import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { browserTz } from '@/lib/time';

// Portal-wide "viewing timezone". A null override means **Auto**: each screen
// shows times in its own natural zone (the venue's tz for venue/booking/schedule
// screens, the viewer's browser tz for account-level screens). Choosing a zone
// in the top-bar selector overrides every screen to that zone.
//
// This is display-only — it never affects how events are scheduled or how slots
// are released; those stay anchored to the venue's own timezone.

const STORAGE_KEY = 'circls.viewingTz';

interface TimezoneContextValue {
  /** Explicit global override, or null = Auto (follow each screen's natural tz). */
  viewingTz: string | null;
  /** Set the override; pass null to return to Auto. Persisted per device. */
  setViewingTz: (tz: string | null) => void;
  /** The viewer's browser tz — the Auto fallback for account-level screens. */
  browserTz: string;
  /**
   * Resolve the tz to actually display in: the override if set, else the
   * screen's natural tz (e.g. the venue tz), else the browser tz.
   */
  resolveTz: (naturalTz?: string | null) => string;
}

const TimezoneContext = createContext<TimezoneContextValue | null>(null);

export function TimezoneProvider({ children }: { children: React.ReactNode }) {
  const [viewingTz, setViewingTzState] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem(STORAGE_KEY) || null;
  });

  // Resolved once per session; the browser tz doesn't change mid-session.
  const bTz = useMemo(() => browserTz(), []);

  const setViewingTz = useCallback((tz: string | null) => {
    setViewingTzState(tz);
    if (typeof window === 'undefined') return;
    if (tz) localStorage.setItem(STORAGE_KEY, tz);
    else localStorage.removeItem(STORAGE_KEY);
  }, []);

  const resolveTz = useCallback(
    (naturalTz?: string | null) => viewingTz ?? naturalTz ?? bTz,
    [viewingTz, bTz],
  );

  const value = useMemo<TimezoneContextValue>(
    () => ({ viewingTz, setViewingTz, browserTz: bTz, resolveTz }),
    [viewingTz, setViewingTz, bTz, resolveTz],
  );

  return <TimezoneContext.Provider value={value}>{children}</TimezoneContext.Provider>;
}

export function useTimezone(): TimezoneContextValue {
  const ctx = useContext(TimezoneContext);
  if (!ctx) throw new Error('useTimezone must be used within <TimezoneProvider>');
  return ctx;
}
