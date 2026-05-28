import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import sensible from '@fastify/sensible';
import { env } from './config/env.js';
import { AppError } from './lib/errors.js';
import { healthRoutes } from './routes/health.js';
import { meRoutes } from './routes/me.js';
import { tenantRoutes } from './routes/tenants.js';
import { arenaRoutes } from './routes/arenas.js';
import { bookingRoutes } from './routes/bookings.js';
import { pricingRoutes } from './routes/pricing.js';
import { slotRoutes } from './routes/slots.js';
import { venueRoutes } from './routes/venues.js';
// Track B (Phases 11–17).
import { kycRoutes } from './routes/kyc.js';
import { paymentRoutes } from './routes/payments.js';
import { razorpayWebhookRoutes } from './routes/webhooks_razorpay.js';
import { eventRoutes } from './routes/events.js';
import { membershipRoutes } from './routes/memberships.js';
import { apiKeyRoutes } from './routes/api_keys.js';
import { webhookSubscriptionRoutes } from './routes/webhook_subscriptions.js';
import { cancellationRoutes } from './routes/cancellations.js';
import { adminRefundRoutes } from './routes/admin_refunds.js';

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      base: { service: 'circls-api' },
      ...(env.NODE_ENV !== 'production'
        ? {
            transport: {
              target: 'pino-pretty',
              options: {
                colorize: true,
                translateTime: 'SYS:HH:MM:ss.l',
                ignore: 'pid,hostname,service',
              },
            },
          }
        : {}),
    },
    disableRequestLogging: false,
    trustProxy: true,
    bodyLimit: 1_048_576,
  });

  await app.register(helmet, { global: true });
  await app.register(cors, { origin: true, credentials: true });
  await app.register(sensible);

  app.setErrorHandler((err: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof AppError) {
      req.log.warn({ err }, 'app_error');
      return reply.status(err.httpStatus).send({
        error: {
          code: err.code,
          message: err.message,
          ...(err.details ? { details: err.details } : {}),
        },
      });
    }

    if (err.validation) {
      req.log.warn({ err }, 'validation_error');
      return reply.status(400).send({
        error: {
          code: 'bad_request',
          message: err.message,
          details: { issues: err.validation },
        },
      });
    }

    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) {
      req.log.error({ err }, 'unhandled_error');
    } else {
      req.log.warn({ err }, 'client_error');
    }
    return reply.status(status).send({
      error: {
        code: status >= 500 ? 'internal_error' : 'bad_request',
        message:
          status >= 500 && env.NODE_ENV === 'production'
            ? 'Internal server error'
            : err.message,
      },
    });
  });

  app.setNotFoundHandler((req: FastifyRequest, reply: FastifyReply) => {
    return reply.status(404).send({
      error: {
        code: 'not_found',
        message: `Route ${req.method} ${req.url} not found`,
      },
    });
  });

  await app.register(healthRoutes);
  await app.register(meRoutes);
  await app.register(tenantRoutes);
  await app.register(venueRoutes);
  await app.register(arenaRoutes);
  await app.register(bookingRoutes);
  await app.register(slotRoutes);
  await app.register(pricingRoutes);
  // Track B (Phases 11–17). Stubs throw at handler-time; routes mount so
  // OpenAPI / route-existence probes pass.
  await app.register(kycRoutes);
  await app.register(paymentRoutes);
  await app.register(razorpayWebhookRoutes);
  await app.register(eventRoutes);
  await app.register(membershipRoutes);
  await app.register(apiKeyRoutes);
  await app.register(webhookSubscriptionRoutes);
  await app.register(cancellationRoutes);
  await app.register(adminRefundRoutes);

  return app;
}
