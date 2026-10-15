/**
 * Fire-and-forget behavioural logger for circls.app — the web twin of the
 * Flutter app's ActivityLogger. Rows land in the API's `consumer_activity`
 * table via POST /v1/consumer/activity, stamped `app: 'web'`.
 *
 * `log` is synchronous, never awaits and never throws: it stamps and enqueues
 * an event. The queue drains in the background once it holds `batchThreshold`
 * events, on the periodic flush the provider drives, and when the tab is
 * hidden. The queue is capped at `maxQueue`; the oldest events go first so a
 * long signed-out browse cannot grow memory without bound.
 *
 * The ingest endpoint needs a signed-in user (the API stamps user_id from the
 * token), so nothing is sent until `setReady(true)`. Events logged before that
 * — a signed-out browse — wait in the queue and go out after sign-in in the
 * same session, which is what joins "looked at this event" to "booked it".
 * A visitor who never signs in sends nothing; the provider keeps that queue in
 * sessionStorage so the sign-in redirect does not lose it.
 */

export interface ActivityEvent {
  eventType: string;
  itemType?: string;
  itemId?: string;
  props?: Record<string, unknown>;
  /** Device clock, ISO 8601. The server records its own `created_at` too. */
  clientTs: string;
  sessionId: string;
}

export interface LogOptions {
  itemType?: string;
  itemId?: string;
  props?: Record<string, unknown>;
}

export interface ActivityLoggerOptions {
  /** Transport: deliver one batch (≤ 200 events). Rejections are swallowed. */
  send: (events: ActivityEvent[]) => Promise<void>;
  sessionId: string;
  batchThreshold?: number;
  maxQueue?: number;
  /** Injectable clock for tests. */
  now?: () => Date;
  /**
   * Called after every change to the queue with what is still waiting and
   * whether sending is currently allowed (the provider persists the queue
   * while it is not).
   */
  onChange?: (pending: ActivityEvent[], ready: boolean) => void;
}

/** The API accepts at most this many events per batch. */
export const MAX_BATCH = 200;

export class ActivityLogger {
  private readonly send: (events: ActivityEvent[]) => Promise<void>;
  private readonly batchThreshold: number;
  private readonly maxQueue: number;
  private readonly now: () => Date;
  private readonly onChange: ((pending: ActivityEvent[], ready: boolean) => void) | undefined;
  private session: string;
  private queue: ActivityEvent[] = [];
  private ready = false;
  private flushing: Promise<void> | null = null;
  private flushAgain = false;

  constructor(opts: ActivityLoggerOptions) {
    this.send = opts.send;
    this.session = opts.sessionId;
    this.batchThreshold = opts.batchThreshold ?? 20;
    this.maxQueue = opts.maxQueue ?? 500;
    this.now = opts.now ?? (() => new Date());
    this.onChange = opts.onChange;
  }

  /** The session every new event is stamped with. */
  get sessionId(): string {
    return this.session;
  }

  /** Number of events waiting to be sent (including any batch in flight). */
  get pendingCount(): number {
    return this.queue.length;
  }

  /** Whether batches may be sent (a signed-in user is present). */
  get isReady(): boolean {
    return this.ready;
  }

  /** A copy of everything still waiting, oldest first. */
  snapshot(): ActivityEvent[] {
    return [...this.queue];
  }

  /** Stamp and enqueue. Never awaits, never throws. */
  log(eventType: string, opts: LogOptions = {}): void {
    try {
      const event: ActivityEvent = {
        eventType,
        clientTs: this.now().toISOString(),
        sessionId: this.session,
        ...(opts.itemType ? { itemType: opts.itemType } : {}),
        ...(opts.itemId ? { itemId: opts.itemId } : {}),
        ...(opts.props ? { props: opts.props } : {}),
      };
      while (this.queue.length >= this.maxQueue) this.queue.shift();
      this.queue.push(event);
      this.changed();
      if (this.ready && this.queue.length >= this.batchThreshold) void this.flush();
    } catch {
      // Logging must never break the caller.
    }
  }

  /** Put events back (restored from storage after a reload). Oldest first. */
  restore(events: ActivityEvent[]): void {
    const keep = events.filter((e) => e && typeof e.eventType === 'string' && typeof e.clientTs === 'string');
    this.queue = [...keep, ...this.queue].slice(-this.maxQueue);
    this.changed();
  }

  /**
   * Forget everything waiting and start a new session. Used when the signed-in
   * person changes: what the previous one did must not go out under the next
   * one's identity. A batch already in flight is not recalled.
   */
  reset(sessionId: string): void {
    this.session = sessionId;
    this.queue = [];
    this.changed();
  }

  /** Allow (or stop) sending. Turning ready on drains whatever is waiting. */
  setReady(ready: boolean): void {
    this.ready = ready;
    this.changed();
    if (ready && this.queue.length > 0) void this.flush();
  }

  /**
   * Drain the queue to the transport in ≤ 200-event batches. A no-op when not
   * ready or empty. Concurrent calls coalesce: a second flush while one is in
   * flight runs once the first finishes. Never throws.
   *
   * A batch stays in the queue until its send settles, so a flush cut short by
   * the page unloading leaves the events where the provider's persisted copy
   * can resend them on the next load. Once the send settles the batch is
   * removed either way: a failed batch is dropped on purpose (telemetry is
   * best-effort, and retrying could double-count).
   */
  flush(): Promise<void> {
    if (!this.ready || this.queue.length === 0) return this.flushing ?? Promise.resolve();
    if (this.flushing) {
      this.flushAgain = true;
      return this.flushing;
    }
    const run = (async () => {
      try {
        while (this.ready && this.queue.length > 0) {
          const batch = this.queue.slice(0, MAX_BATCH);
          try {
            await this.send(batch);
          } catch {
            // Dropped on purpose; see above.
          }
          const sent = new Set(batch);
          this.queue = this.queue.filter((e) => !sent.has(e));
          this.changed();
        }
      } finally {
        this.flushing = null;
        if (this.flushAgain) {
          this.flushAgain = false;
          void this.flush();
        }
      }
    })();
    this.flushing = run;
    return run;
  }

  private changed(): void {
    try {
      this.onChange?.(this.queue, this.ready);
    } catch {
      // A persistence failure must not break logging.
    }
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Route segments whose next segment is a free-form identifier, not a uuid. */
const SLUG_PARENTS = new Set(['orgs']);

/**
 * Collapse a pathname to its route pattern so screens group in reports:
 * `/events/0193…` → `/events/[id]`, `/orgs/acme-sports` → `/orgs/[slug]`.
 * A short fixed segment such as `bookings` or `me` is kept as is.
 */
export function routePattern(pathname: string): string {
  const segs = pathname.split('/');
  return segs
    .map((seg, i) => {
      if (UUID.test(seg)) return '[id]';
      if (seg && i > 0 && SLUG_PARENTS.has(segs[i - 1] ?? '')) return '[slug]';
      return seg;
    })
    .join('/');
}
