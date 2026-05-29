import crypto from 'node:crypto';

/**
 * Sign an outbound webhook body with a subscription's HMAC secret. The receiver
 * verifies by recomputing the same HMAC-SHA256 hex over the raw body using their
 * shared secret. We add `X-Circls-Signature: t=<ts>,v1=<hex>` so the timestamp
 * is checkable against replay (suggest a 5-minute clock skew tolerance).
 */
export interface SignedDelivery {
  /** Header value to send as `X-Circls-Signature`. */
  signatureHeader: string;
  /** Unix ms timestamp used in the signature. */
  timestamp: number;
}

export function signWebhook(rawBody: string, secret: string): SignedDelivery {
  const timestamp = Date.now();
  const payload = `${timestamp}.${rawBody}`;
  const hex = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return { signatureHeader: `t=${timestamp},v1=${hex}`, timestamp };
}

/** Constant-time verify. Used by aggregator partners; we export it for tests too. */
export function verifyWebhook(
  rawBody: string,
  signatureHeader: string,
  secret: string,
  toleranceMs = 5 * 60 * 1000,
): boolean {
  const parts = Object.fromEntries(signatureHeader.split(',').map((p) => p.split('=') as [string, string]));
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isFinite(t) || !v1) return false;
  if (Math.abs(Date.now() - t) > toleranceMs) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(v1, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
