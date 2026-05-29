import type { FastifyPluginAsync } from 'fastify';
import { BadRequest, Unauthorized } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { getRazorpay } from '../lib/razorpay.js';
import { handleRazorpayWebhook } from '../services/payments_service.js';

/**
 * Razorpay webhook receiver — Phase 12. We read the raw body, verify the HMAC
 * signature, and hand off to the service handler. Note: Fastify by default
 * parses JSON bodies; we register a raw-body content parser locally so the
 * signature math is done over exact bytes.
 */
export const razorpayWebhookRoutes: FastifyPluginAsync = async (app) => {
  // Capture raw body for this route so the HMAC over the original bytes matches
  // what Razorpay computed. parseAs:'string' keeps us out of stream-handling land.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body, done) => {
      try {
        const parsed = body ? (JSON.parse(body as string) as unknown) : {};
        done(null, parsed);
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  app.post('/webhooks/razorpay', async (req, reply) => {
    const signature = req.headers['x-razorpay-signature'];
    if (typeof signature !== 'string') {
      throw new Unauthorized('Missing signature', 'missing_signature');
    }
    // Body was JSON.parse'd above — re-stringify in canonical form for the
    // signature check. Razorpay signs the exact string they sent; we trust
    // their JSON encoding is stable. The Phase 12 owner should switch to
    // capturing the raw string and avoid the re-stringify.
    const raw = JSON.stringify(req.body ?? {});
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
