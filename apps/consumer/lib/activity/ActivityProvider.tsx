'use client';

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { apiFetch } from '@/lib/api/client';
import { useAuth } from '@/lib/firebase/auth_context';
import { ActivityLogger, routePattern, type ActivityEvent } from './logger';

/** Every batch from this site carries this marker (consumer_activity.app). */
const APP = 'web';
const SESSION_KEY = 'circls.activity.session';
const QUEUE_KEY = 'circls.activity.queue';
/** How many signed-out events survive a reload / sign-in redirect. */
const PERSIST_LIMIT = 200;
/** Periodic drain while the tab is open. */
const FLUSH_MS = 30_000;
/** Proof of life while the tab is visible — gives sessions a duration. */
const HEARTBEAT_MS = 60_000;

const ActivityContext = createContext<ActivityLogger | null>(null);

/** Per-tab session id, kept across reloads; a new tab is a new session. */
function sessionId(): { id: string; fresh: boolean } {
  try {
    const existing = window.sessionStorage.getItem(SESSION_KEY);
    if (existing) return { id: existing, fresh: false };
  } catch {
    // Storage blocked: a per-page-load id is the best we can do.
  }
  const id =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    window.sessionStorage.setItem(SESSION_KEY, id);
  } catch {
    // ignore
  }
  return { id, fresh: true };
}

function readPersisted(): ActivityEvent[] {
  try {
    const raw = window.sessionStorage.getItem(QUEUE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ActivityEvent[]) : [];
  } catch {
    return [];
  }
}

function persist(pending: ActivityEvent[]): void {
  try {
    if (pending.length === 0) window.sessionStorage.removeItem(QUEUE_KEY);
    else window.sessionStorage.setItem(QUEUE_KEY, JSON.stringify(pending.slice(-PERSIST_LIMIT)));
  } catch {
    // ignore
  }
}

async function sendBatch(events: ActivityEvent[]): Promise<void> {
  await apiFetch<{ accepted: number }>('/v1/consumer/activity', {
    method: 'POST',
    body: JSON.stringify({ app: APP, events }),
    // Let a flush started on pagehide outlive the page.
    keepalive: true,
  });
}

/** Built once per tab, on the client. On the server a mute logger stands in. */
function createLogger(): ActivityLogger {
  if (typeof window === 'undefined') {
    return new ActivityLogger({ send: async () => {}, sessionId: 'ssr' });
  }
  const session = sessionId();
  const logger = new ActivityLogger({ send: sendBatch, sessionId: session.id, onChange: persist });
  logger.restore(readPersisted());
  if (session.fresh) {
    logger.log('session_start', {
      props: {
        app: APP,
        referrer: document.referrer || null,
        landing: window.location.pathname,
        ...utmProps(window.location.search),
      },
    });
  }
  return logger;
}

/** The campaign parameters on the landing URL, if any, as `utm_*` props. */
function utmProps(search: string): Record<string, string> {
  const out: Record<string, string> = {};
  const params = new URLSearchParams(search);
  for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']) {
    const v = params.get(key);
    if (v) out[key] = v.slice(0, 100);
  }
  return out;
}

/**
 * Mounts the site-wide behavioural logger: one per tab, sending only while a
 * user is signed in. Records a `screen_view` per route change, a `heartbeat`
 * every minute the tab is visible, and drains the queue every 30 s and when
 * the tab is hidden. Pages log their own `search`, `item_view`, `slot_select`,
 * `like` and `booking_created` through `useActivity()`.
 */
export function ActivityProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const pathname = usePathname();
  const [logger] = useState(createLogger);

  useEffect(() => {
    logger.setReady(Boolean(user));
  }, [logger, user]);

  // Keyed off the path so React's double-invoked dev effects can't log twice.
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (!pathname || seen.current === pathname) return;
    seen.current = pathname;
    logger.log('screen_view', { props: { route: routePattern(pathname), path: pathname } });
  }, [logger, pathname]);

  useEffect(() => {
    const flushTimer = window.setInterval(() => void logger.flush(), FLUSH_MS);
    const beat = window.setInterval(() => {
      if (document.visibilityState === 'visible') logger.log('heartbeat');
    }, HEARTBEAT_MS);
    const onHide = () => {
      if (document.visibilityState === 'hidden') void logger.flush();
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onHide);
    return () => {
      window.clearInterval(flushTimer);
      window.clearInterval(beat);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onHide);
    };
  }, [logger]);

  return <ActivityContext.Provider value={logger}>{children}</ActivityContext.Provider>;
}

export function useActivity(): ActivityLogger {
  const ctx = useContext(ActivityContext);
  if (!ctx) throw new Error('useActivity must be used within <ActivityProvider>');
  return ctx;
}

/**
 * Log one `item_view` for a listing detail page, once per id. `enabled`
 * false (a partner's preview of an unapproved listing) logs nothing.
 */
export function useItemView(itemType: 'event' | 'venue' | 'membership', itemId: string, enabled = true): void {
  const logger = useActivity();
  const last = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled || !itemId || last.current === itemId) return;
    last.current = itemId;
    logger.log('item_view', { itemType, itemId });
  }, [logger, itemType, itemId, enabled]);
}
