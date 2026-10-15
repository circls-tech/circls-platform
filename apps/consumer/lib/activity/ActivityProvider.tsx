'use client';

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { onIdTokenChanged } from 'firebase/auth';
import { API_BASE, apiFetch } from '@/lib/api/client';
import { auth } from '@/lib/firebase/client';
import { useAuth } from '@/lib/firebase/auth_context';
import { sessionRead, sessionRemove, sessionWrite } from '@/lib/storage';
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

/** Stands in wherever no provider is mounted: logs are accepted and dropped. */
const MUTE = new ActivityLogger({ send: async () => {}, sessionId: 'none' });

function mintSessionId(): string {
  const id =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  sessionWrite(SESSION_KEY, id);
  return id;
}

/** Per-tab session id, kept across reloads; a new tab is a new session. */
function currentSessionId(): { id: string; fresh: boolean } {
  const existing = sessionRead(SESSION_KEY);
  if (existing) return { id: existing, fresh: false };
  return { id: mintSessionId(), fresh: true };
}

function readPersisted(): ActivityEvent[] {
  try {
    const raw = sessionRead(QUEUE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ActivityEvent[]) : [];
  } catch {
    return [];
  }
}

function persist(pending: ActivityEvent[]): void {
  if (pending.length === 0) sessionRemove(QUEUE_KEY);
  else sessionWrite(QUEUE_KEY, JSON.stringify(pending.slice(-PERSIST_LIMIT)));
}

/**
 * Queue persistence policy. Signed out, every change is written: that queue
 * can live for a whole browse and must survive the sign-in redirect. Signed
 * in, the queue drains within seconds, so it is only written on tab hide (see
 * the provider) and cleared once empty — not serialised on every heartbeat.
 */
function onQueueChange(pending: ActivityEvent[], ready: boolean): void {
  if (!ready) persist(pending);
  else if (pending.length === 0) sessionRemove(QUEUE_KEY);
}

/**
 * The signed-in user's current ID token, kept fresh by Firebase's own refresh
 * cycle. Held so a flush fired as the page unloads can dispatch its request
 * synchronously (keepalive) instead of first awaiting a token lookup that the
 * teardown may never let resolve.
 */
let cachedToken: string | null = null;

async function sendBatch(events: ActivityEvent[]): Promise<void> {
  const body = JSON.stringify({ app: APP, events });
  const token = cachedToken;
  if (token) {
    const res = await fetch(`${API_BASE}/v1/consumer/activity`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body,
      // Let a flush started on pagehide outlive the page.
      keepalive: true,
    });
    if (res.status !== 401) return;
    // The cached token went stale: fall through to the refreshing path.
    cachedToken = null;
  }
  await apiFetch<{ accepted: number }>('/v1/consumer/activity', { method: 'POST', body, keepalive: true });
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

function logSessionStart(logger: ActivityLogger): void {
  logger.log('session_start', {
    props: {
      app: APP,
      referrer: document.referrer || null,
      landing: window.location.pathname,
      ...utmProps(window.location.search),
    },
  });
}

/** Built once per tab, on the client. On the server the mute logger stands in. */
function createLogger(): ActivityLogger {
  if (typeof window === 'undefined') return MUTE;
  const session = currentSessionId();
  const logger = new ActivityLogger({ send: sendBatch, sessionId: session.id, onChange: onQueueChange });
  logger.restore(readPersisted());
  if (session.fresh) logSessionStart(logger);
  return logger;
}

/**
 * Mounts the site-wide behavioural logger: one per tab, sending only while a
 * user is signed in. Records a `screen_view` per route change, a `heartbeat`
 * every minute the tab is visible and signed in, and drains the queue every
 * 30 s and when the tab is hidden or left. Pages log their own `search`,
 * `item_view`, `slot_select`, `like` and `booking_created` through
 * `useActivity()`.
 */
export function ActivityProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const pathname = usePathname();
  const [logger] = useState(createLogger);

  // Who the queue belongs to. A signed-out browse that ends in a sign-in keeps
  // its events (that join is the point); a sign-out, or one account replacing
  // another in the same tab, starts over so nothing goes out under the wrong
  // person. `undefined` = not seen a user state yet.
  const owner = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    return onIdTokenChanged(auth, (u) => {
      if (!u) {
        cachedToken = null;
        return;
      }
      void u.getIdToken().then((t) => (cachedToken = t)).catch(() => {});
    });
  }, []);
  useEffect(() => {
    const uid = user?.uid ?? null;
    const previous = owner.current;
    owner.current = uid;
    if (typeof previous === 'string' && previous !== uid) {
      logger.setReady(false);
      logger.reset(mintSessionId());
      sessionRemove(QUEUE_KEY);
      logSessionStart(logger);
    }
    logger.setReady(uid !== null);
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
    // Heartbeats only once they can be sent: queued up while signed out they
    // would crowd the real browse events out of the capped queue.
    const beat = window.setInterval(() => {
      if (logger.isReady && document.visibilityState === 'visible') logger.log('heartbeat');
    }, HEARTBEAT_MS);
    // Leaving: send what is waiting. With the token cached the request goes
    // out before the page is torn down; the queue is deliberately NOT written
    // to storage here, which would resend the same batch on the next load.
    const leave = () => void logger.flush();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') leave();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', leave);
    return () => {
      window.clearInterval(flushTimer);
      window.clearInterval(beat);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', leave);
    };
  }, [logger]);

  return <ActivityContext.Provider value={logger}>{children}</ActivityContext.Provider>;
}

/**
 * The site logger. Outside an <ActivityProvider> it is a mute logger rather
 * than an error: telemetry must never take a page down.
 */
export function useActivity(): ActivityLogger {
  return useContext(ActivityContext) ?? MUTE;
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
