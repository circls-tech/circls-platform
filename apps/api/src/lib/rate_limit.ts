import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { env } from '../config/env.js';
import { RateLimit } from './errors.js';

/**
 * The rate-limit bucket for a request whose caller has been VERIFIED: the
 * Firebase uid set by `requireAuth`, the API key id set by `requireApiKey`,
 * else the client IP.
 *
 * Only use this behind those preHandlers. Before them the Authorization header
 * is just a string of the caller's choosing, and keying on it hands out a
 * fresh bucket per value — no limit at all for anyone rotating tokens. The
 * global limiter in server.ts therefore keys on the IP alone.
 */
export function verifiedIdentityKey(req: FastifyRequest): string {
  if (req.authUser) return `uid:${req.authUser.firebaseUid}`;
  if (req.apiKey) return `key:${req.apiKey.id}`;
  return `ip:${req.ip}`;
}

/**
 * A per-identity limiter for a route's `preHandler` list, placed AFTER
 * `requireAuth` / `requireApiKey`. It complements the global per-IP ceiling:
 * a caller spreading requests over many addresses still shares one bucket.
 * Off under test, like the global limiter — the suite hammers app.inject().
 */
export function perIdentityRateLimit(
  app: FastifyInstance,
  max: number = env.RATE_LIMIT_PUBLIC_MAX,
): preHandlerAsyncHookHandler {
  // `createRateLimit` is the plugin's bare counter. (`app.rateLimit()` would
  // be the obvious choice, but it shares a per-request "already ran" flag
  // with the global onRequest limiter and so never fires after it.)
  const check = app.createRateLimit({
    max,
    timeWindow: '1 minute',
    keyGenerator: verifiedIdentityKey,
    allowList: () => env.NODE_ENV === 'test',
  });
  return async (req, reply) => {
    const result = await check(req);
    if (result.isAllowed || !result.isExceeded) return;
    reply.header('retry-after', String(result.ttlInSeconds));
    throw new RateLimit(
      `Too many requests. Try again in ${result.ttlInSeconds} second${result.ttlInSeconds === 1 ? '' : 's'}.`,
      'rate_limited',
      { retryAfterSeconds: result.ttlInSeconds },
    );
  };
}
