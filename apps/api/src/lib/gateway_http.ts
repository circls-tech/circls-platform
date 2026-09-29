/**
 * The one HTTP path every payment-gateway adapter (Razorpay, Stripe, Cashfree)
 * uses to talk to its provider. It exists for two reasons:
 *
 *   1. A hard timeout (`GATEWAY_HTTP_TIMEOUT_MS`). Refunds call the gateway
 *      inside row-locked transactions; without a timeout a gateway that
 *      accepts the connection but never answers pins those locks and a pool
 *      connection for undici's ~5 min defaults.
 *   2. A typed failure. `GatewayHttpError.outage` tells the INR failover
 *      breaker whether the provider itself is struggling (timeout, network
 *      error, 5xx, 429) or just refused this one request (other 4xx).
 */
import { env } from '../config/env.js';
import { logger } from './logger.js';

export class GatewayHttpError extends Error {
  constructor(
    message: string,
    /** 'razorpay' | 'stripe' | 'cashfree' — which provider failed. */
    readonly provider: string,
    /** HTTP status, or null when no response arrived (timeout / network). */
    readonly status: number | null,
    /** True when the provider looks down rather than refusing our request. */
    readonly outage: boolean,
  ) {
    super(message);
    this.name = 'GatewayHttpError';
  }
}

export interface GatewayRequest {
  provider: string;
  /** Human label for messages, e.g. 'Cashfree'. */
  label: string;
  method: 'GET' | 'POST' | 'PATCH';
  baseUrl: string;
  path: string;
  headers: Record<string, string>;
  body?: string | undefined;
  /** Pulls the provider's error text out of a failed response's JSON body. */
  errorMessage: (body: unknown) => string | undefined;
}

export async function gatewayRequest<T>(req: GatewayRequest): Promise<T> {
  const { provider, label, method, path } = req;
  let res: Response;
  let text: string;
  try {
    res = await fetch(`${req.baseUrl}${path}`, {
      method,
      headers: req.headers,
      ...(req.body !== undefined ? { body: req.body } : {}),
      // Covers reading the body too: an aborted signal cancels the stream.
      signal: AbortSignal.timeout(env.GATEWAY_HTTP_TIMEOUT_MS),
    });
    text = await res.text();
  } catch (err) {
    const timedOut =
      err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    const reason = err instanceof Error ? err.message : String(err);
    logger.error({ provider, path, timedOut, reason }, `${provider}_api_unreachable`);
    throw new GatewayHttpError(
      `${label} ${path} ${timedOut ? 'timed out' : `unreachable: ${reason}`}`,
      provider,
      null,
      true,
    );
  }

  if (!res.ok) {
    let message = text;
    try {
      message = req.errorMessage(JSON.parse(text)) ?? text;
    } catch {
      /* keep raw text */
    }
    logger.error({ status: res.status, path, message }, `${provider}_api_error`);
    throw new GatewayHttpError(
      `${label} ${path} failed (${res.status}): ${message}`,
      provider,
      res.status,
      res.status >= 500 || res.status === 429,
    );
  }
  return JSON.parse(text) as T;
}
