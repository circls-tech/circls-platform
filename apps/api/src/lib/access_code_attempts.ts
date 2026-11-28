import type { FastifyRequest } from 'fastify';
import { AppError, RateLimit } from './errors.js';
import { verifiedIdentityKey } from './rate_limit.js';

/**
 * Wrong-code ceiling for invite-only (access_code) events.
 *
 * The general per-minute limiter lets a caller try hundreds of codes an hour;
 * this counts only WRONG codes, per caller per event, and refuses further
 * tries for a while once the ceiling is hit. A right code is never counted,
 * so an invitee re-reading the page is unaffected, and one caller's failures
 * never lock the event for anyone else.
 *
 * In memory, like the rate limiter (single API instance); a restart forgets.
 */
export const ACCESS_CODE_MAX_FAILURES = 8;
export const ACCESS_CODE_WINDOW_MS = 15 * 60 * 1000;
/** Cap on tracked callers, so a flood of keys cannot grow the map unbounded. */
const MAX_TRACKED = 50_000;

interface Entry {
  failures: number;
  /** When the window that `failures` belongs to ends. */
  resetAt: number;
}

export class AccessCodeAttempts {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly max = ACCESS_CODE_MAX_FAILURES,
    private readonly windowMs = ACCESS_CODE_WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Seconds until `key` may try again, or 0 when it may try now. */
  retryAfterSeconds(key: string): number {
    const e = this.live(key);
    if (!e || e.failures < this.max) return 0;
    return Math.max(1, Math.ceil((e.resetAt - this.now()) / 1000));
  }

  recordFailure(key: string): void {
    const e = this.live(key);
    if (e) {
      e.failures += 1;
      return;
    }
    if (this.entries.size >= MAX_TRACKED) this.sweep();
    if (this.entries.size >= MAX_TRACKED) {
      // Still full of live entries: drop the oldest rather than stop counting.
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { failures: 1, resetAt: this.now() + this.windowMs });
  }

  private live(key: string): Entry | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (e.resetAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return e;
  }

  private sweep(): void {
    const now = this.now();
    for (const [k, e] of this.entries) if (e.resetAt <= now) this.entries.delete(k);
  }
}

const attempts = new AccessCodeAttempts();

/** The request header an access code travels in on the event read — a header,
 *  not a query string, so the code stays out of the request log's URL (the
 *  header is redacted in server.ts). URI-encoded, as a code may be any text. */
export const ACCESS_CODE_HEADER = 'x-circls-access-code';

/** The access code on a request's header, decoded; undefined when absent or unusable. */
export function accessCodeHeaderOf(req: FastifyRequest): string | undefined {
  const raw = req.headers[ACCESS_CODE_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || value.length === 0 || value.length > 600) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return undefined;
  }
  const trimmed = decoded.trim();
  return trimmed.length > 0 && trimmed.length <= 64 ? trimmed : undefined;
}

/**
 * Run `fn`, an operation that checks `code` against `eventId`, under the
 * wrong-code ceiling. With no code there is nothing being guessed and `fn`
 * runs as is. Otherwise a caller already over the ceiling is refused (429)
 * before the code is looked at, and a wrong code — `fn` throwing
 * `event_access_code_invalid`, or `wasWrong(result)` — is counted.
 */
export async function withAccessCodeAttempt<T>(
  req: FastifyRequest,
  eventId: string,
  code: string | undefined,
  fn: () => Promise<T>,
  wasWrong: (result: T) => boolean = () => false,
): Promise<T> {
  if (!code) return fn();
  const key = `${verifiedIdentityKey(req)}|${eventId}`;
  const wait = attempts.retryAfterSeconds(key);
  if (wait > 0) {
    const minutes = Math.ceil(wait / 60);
    throw new RateLimit(
      `Too many wrong codes. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      'event_access_code_attempts',
      { retryAfterSeconds: wait },
    );
  }
  try {
    const result = await fn();
    if (wasWrong(result)) attempts.recordFailure(key);
    return result;
  } catch (err) {
    if (err instanceof AppError && err.code === 'event_access_code_invalid') {
      attempts.recordFailure(key);
    }
    throw err;
  }
}
