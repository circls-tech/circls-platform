import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { env } from '../config/env.js';
import { BadRequest, Unauthorized } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { getRazorpay } from '../lib/razorpay.js';
import { handleRazorpayWebhook } from '../services/payments_service.js';

/** Request augmented with the exact bytes we received, for HMAC verification. */
type RawBodyRequest = FastifyRequest & { rawBody?: string };

/**
 * Razorpay webhook receiver — Phase 12. Razorpay signs the EXACT bytes it sent,
 * so we stash the raw request string in a content parser and verify the HMAC
 * against that — never a re-stringified copy (key order / escaping / whitespace
 * differences would break the signature).
 */
export const razorpayWebhookRoutes: FastifyPluginAsync = async (app) => {
  // parseAs:'string' hands us the raw body; we keep it on the request for the
  // signature check, and still parse JSON so the handler gets a typed object.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (req, body, done) => {
      (req as RawBodyRequest).rawBody = body as string;
      try {
        const parsed = body ? (JSON.parse(body as string) as unknown) : {};
        done(null, parsed);
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  app.post('/webhooks/razorpay', async (req, reply) => {
    if (env.NODE_ENV === 'production' && getRazorpay().mode === 'stub') {
      logger.error('razorpay_webhook_stub_in_prod');
      return reply.status(503).send({ error: { code: 'payments_unconfigured' } });
    }
    const signature = req.headers['x-razorpay-signature'];
    if (typeof signature !== 'string') {
      throw new Unauthorized('Missing signature', 'missing_signature');
    }
    // Verify the HMAC over the exact bytes Razorpay sent.
    const raw = (req as RawBodyRequest).rawBody ?? '';
    const ok = getRazorpay().verifyWebhookSignature(raw, signature);
    if (!ok) throw new Unauthorized('Bad signature', 'bad_signature');

    const eventId = req.headers['x-razorpay-event-id'];
    if (typeof eventId !== 'string') {
      throw new BadRequest('Missing event id', 'missing_event_id');
    }
    const body = req.body as { event?: string; payload?: Record<string, unknown> };
    if (!body.event) throw new BadRequest('Missing event type', 'missing_event_type');

    try {
      await handleRazorpayWebhook({
        event: body.event,
        payload: body.payload ?? {},
        eventId,
      });
    } catch (err) {
      logger.error({ err, event: body.event }, 'razorpay_webhook_failed');
      // Razorpay will retry on non-2xx; we surface 500 so they do.
      return reply.status(500).send({ error: { code: 'webhook_failed' } });
    }
    return reply.status(204).send();
  });
};
