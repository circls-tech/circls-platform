import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import sensible from '@fastify/sensible';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
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
import { notificationRoutes } from './routes/notifications.js';
// Phase 16 — platform-admin tooling.
import { adminTenantRoutes } from './routes/admin_tenants.js';
import { adminAuditLogRoutes } from './routes/admin_audit_log.js';
// Phase 17 — aggregator-facing public API surface.
import { publicBookingRoutes } from './routes/public_bookings.js';

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

  // ── OpenAPI (Phase 17) ───────────────────────────────────────────────────
  // Two auth schemes: Firebase ID token (internal portal/admin) and Bearer
  // API key (aggregator-facing `/api/v1/*`). All routes are tagged so the
  // generated client/spec splits the two surfaces clearly.
  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'Circls Platform API',
        description:
          'Circls public + internal API. `/v1/*` is the Firebase-auth internal API used by the admin/partners portals. `/api/v1/*` is the aggregator API authenticated with a Circls API key (Bearer ck_…).',
        version: '0.1.0',
      },
      servers: [
        { url: 'https://api.circls.app', description: 'production' },
        { url: 'http://localhost:8080', description: 'local' },
      ],
      tags: [
        { name: 'public', description: 'Aggregator-facing API key surface.' },
        { name: 'bookings', description: 'Booking lifecycle (internal).' },
        { name: 'venues', description: 'Venue + arena management.' },
        { name: 'slots', description: 'Slot inventory + holds.' },
        { name: 'tenants', description: 'Tenant + membership management.' },
        { name: 'integration', description: 'API keys + outbound webhooks.' },
        { name: 'meta', description: 'Auth / health / self.' },
      ],
      components: {
        securitySchemes: {
          firebaseAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'Firebase ID token',
            description: 'Firebase ID token from the partner portal sign-in.',
          },
          apiKey: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'ck_… key',
            description: 'Circls API key issued under /v1/tenants/:tenantId/api-keys.',
          },
        },
      },
    },
  });
  if (env.NODE_ENV !== 'production') {
    await app.register(swaggerUi, { routePrefix: '/openapi/ui' });
  }
  // Mount the spec at a stable URL (in addition to the swagger-ui default).
  app.get('/openapi.json', async () => app.swagger());

  // Decorate request once for API-key auth (Fastify v5 requirement: declared
  // properties must be initialized at build time, not per-request).
  app.decorateRequest('apiKey', null);
  app.decorateRequest('apiTenantId', null);

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
  await app.register(notificationRoutes);
  // Phase 16: platform-admin endpoints (both gated by requirePlatformAdmin).
  await app.register(adminTenantRoutes);
  await app.register(adminAuditLogRoutes);
  // Phase 17: public aggregator API (Bearer ck_… auth, channel='aggregator').
  await app.register(publicBookingRoutes);

  return app;
}
