import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { env } from '../config/env.js';
import { BadRequest, Unauthorized } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { getGateway } from '../lib/gateway.js';
import { handleStripeWebhook } from '../services/payments_service.js';

/** Request augmented with the exact bytes we received, for HMAC verification. */
type RawBodyRequest = FastifyRequest & { rawBody?: string };

/**
 * Stripe webhook receiver. Mirrors webhooks_razorpay.ts: Stripe signs the
 * EXACT bytes it sent (`${t}.${rawBody}` under the endpoint secret, sent as
 * `Stripe-Signature: t=…,v1=…`), so we verify against the raw request string
 * stashed by the server-scope content parser — never a re-stringified copy.
 *
 * Unlike Razorpay there is no event-id header; the idempotency key is the
 * event's own `id` (`evt_…`) from the signed body.
 */
export const stripeWebhookRoutes: FastifyPluginAsync = async (app) => {
  app.post('/webhooks/stripe', async (req, reply) => {
    const gateway = getGateway('stripe');
    if (env.NODE_ENV === 'production' && gateway.mode === 'stub') {
      logger.error('stripe_webhook_stub_in_prod');
      return reply.status(503).send({ error: { code: 'payments_unconfigured' } });
    }
    const signature = req.headers['stripe-signature'];
    if (typeof signature !== 'string') {
      throw new Unauthorized('Missing signature', 'missing_signature');
    }
    // Verify the HMAC over the exact bytes Stripe sent.
    const raw = (req as RawBodyRequest).rawBody ?? '';
    const ok = gateway.verifyWebhookSignature(raw, signature);
    if (!ok) throw new Unauthorized('Bad signature', 'bad_signature');

    const body = req.body as {
      id?: string;
      type?: string;
      data?: { object?: Record<string, unknown> };
    };
    if (typeof body.id !== 'string' || body.id.length === 0) {
      throw new BadRequest('Missing event id', 'missing_event_id');
    }
    if (!body.type) throw new BadRequest('Missing event type', 'missing_event_type');

    try {
      await handleStripeWebhook({
        type: body.type,
        object: body.data?.object ?? {},
        eventId: body.id,
      });
    } catch (err) {
      logger.error({ err, type: body.type }, 'stripe_webhook_failed');
      // Stripe will retry on non-2xx; we surface 500 so they do.
      return reply.status(500).send({ error: { code: 'webhook_failed' } });
    }
    return reply.status(204).send();
  });
};
