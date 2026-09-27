import crypto from 'node:crypto';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { env } from '../config/env.js';
import { BadRequest, Unauthorized } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { getGateway } from '../lib/gateway.js';
import { handleCashfreeWebhook } from '../services/payments_service.js';

/** Request augmented with the exact bytes we received, for HMAC verification. */
type RawBodyRequest = FastifyRequest & { rawBody?: string };

/**
 * Cashfree payment-gateway webhook receiver. Mirrors webhooks_razorpay.ts:
 * Cashfree signs `x-webhook-timestamp + rawBody` (base64 HMAC-SHA256 under
 * the client secret, sent as `x-webhook-signature`), so we verify against the
 * raw request string stashed by the server-scope content parser — never a
 * re-stringified copy.
 *
 * Idempotency key: the `x-idempotency-key` header (webhook versions
 * ≥ 2025-01-01), else a hash of the signed body — a byte-identical
 * re-delivery is the same event.
 */
export const cashfreeWebhookRoutes: FastifyPluginAsync = async (app) => {
  app.post('/webhooks/cashfree', async (req, reply) => {
    const gateway = getGateway('cashfree');
    if (env.NODE_ENV === 'production' && gateway.mode === 'stub') {
      logger.error('cashfree_webhook_stub_in_prod');
      return reply.status(503).send({ error: { code: 'payments_unconfigured' } });
    }
    const signature = req.headers['x-webhook-signature'];
    const timestamp = req.headers['x-webhook-timestamp'];
    if (typeof signature !== 'string' || typeof timestamp !== 'string') {
      throw new Unauthorized('Missing signature', 'missing_signature');
    }
    // Verify the HMAC over the exact bytes Cashfree sent.
    const raw = (req as RawBodyRequest).rawBody ?? '';
    const ok = gateway.verifyWebhookSignature(raw, signature, timestamp);
    if (!ok) throw new Unauthorized('Bad signature', 'bad_signature');

    const body = req.body as { type?: string; data?: Record<string, unknown> };
    if (!body.type) throw new BadRequest('Missing event type', 'missing_event_type');

    const idempotencyKey = req.headers['x-idempotency-key'];
    const eventId =
      typeof idempotencyKey === 'string' && idempotencyKey.length > 0
        ? idempotencyKey
        : `sha256:${crypto.createHash('sha256').update(raw).digest('hex')}`;

    try {
      await handleCashfreeWebhook({ type: body.type, data: body.data ?? {}, eventId });
    } catch (err) {
      logger.error({ err, type: body.type }, 'cashfree_webhook_failed');
      // Cashfree retries on non-2xx; we surface 500 so it does.
      return reply.status(500).send({ error: { code: 'webhook_failed' } });
    }
    // Cashfree's retry policy keys on a 200 specifically.
    return reply.status(200).send({ ok: true });
  });
};
