import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
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
import { venueImageRoutes } from './routes/venue_images.js';
// Track B (Phases 11–17).
import { paymentRoutes } from './routes/payments.js';
import { razorpayWebhookRoutes } from './routes/webhooks_razorpay.js';
import { eventRoutes } from './routes/events.js';
import { eventImageRoutes } from './routes/event_images.js';
import { membershipRoutes } from './routes/memberships.js';
import { apiKeyRoutes } from './routes/api_keys.js';
import { webhookSubscriptionRoutes } from './routes/webhook_subscriptions.js';
import { notificationRoutes } from './routes/notifications.js';
// Phase 14 — cancellations + admin out-of-policy refunds.
import { cancellationRoutes } from './routes/cancellations.js';
import { adminRefundRoutes } from './routes/admin_refunds.js';
// Phase 16 — platform-admin tooling.
import { adminTenantRoutes } from './routes/admin_tenants.js';
import { adminPayoutRoutes } from './routes/admin_payouts.js';
import { adminListingRoutes } from './routes/admin_listings.js';
import { adminAuditLogRoutes } from './routes/admin_audit_log.js';
// Phase 17 — aggregator-facing public API surface.
import { publicBookingRoutes } from './routes/public_bookings.js';
import { consumerRoutes } from './routes/consumer.js';
// Team management (subproject D).
import { invitationRoutes } from './routes/invitations.js';
import { teamRoutes } from './routes/team.js';
// Support issues (UX issue #20).
import { supportIssueRoutes } from './routes/support_issues.js';

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      base: { service: 'circls-api' },
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers["x-razorpay-signature"]',
          'req.headers.cookie',
          '*.keySecret',
          '*.key_secret',
          '*.plaintextToken',
          '*.token_hash',
          '*.private_key',
          '*.secret',
        ],
        censor: '[REDACTED]',
      },
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
  const allowedOrigins = [...env.CORS_ALLOWED_ORIGINS];
  await app.register(cors, {
    credentials: true,
    origin: (origin, cb) => {
      // No Origin header (server-to-server, curl, same-origin) → allow.
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      if (env.NODE_ENV !== 'production' && /^http:\/\/localhost(:\d+)?$/.test(origin)) return cb(null, true);
      return cb(null, false); // not an error — just no CORS headers, browser blocks it
    },
  });
  await app.register(sensible);

  // ── Rate limiting (M6) ─────────────────────────────────────────────────────
  // Global per-minute ceiling keyed by API key / Firebase token, falling back
  // to client IP (trustProxy is on, so req.ip is the real client). Abuse-prone
  // public/hold/booking routes set a stricter per-route `config.rateLimit` (see
  // slots.ts / consumer.ts / public_bookings.ts); those still inherit this
  // global allowList. In-memory store ⇒ per-instance limits (acceptable on a
  // single-instance Coolify deploy; move to the redis store if we scale out).
  //
  // Disabled under test via allowList (returns truthy ⇒ request excluded). The
  // test suite hammers app.inject(); a high `max` would still flake, so we skip
  // limiting entirely rather than raise the ceiling.
  await app.register(rateLimit, {
    global: true,
    max: env.RATE_LIMIT_MAX,
    timeWindow: '1 minute',
    keyGenerator: (req) => {
      const auth = req.headers.authorization;
      return (typeof auth === 'string' && auth) || req.ip;
    },
    allowList: () => env.NODE_ENV === 'test',
  });

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

  // Raw-body-capturing JSON parser, registered ONCE at server scope (L5).
  // Content-type parsers are app-global in Fastify, so registering this inside
  // a route plugin silently replaced JSON parsing for the whole server and was
  // order-dependent (Razorpay webhook HMAC verification reads req.rawBody and
  // broke if registration order changed). Doing it here is intentional and
  // order-stable: every JSON route still gets a parsed body, and we stash the
  // exact bytes on req.rawBody for signature checks.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (req, body, done) => {
      (req as FastifyRequest & { rawBody?: string }).rawBody = body as string;
      try {
        const parsed = body ? (JSON.parse(body as string) as unknown) : {};
        done(null, parsed);
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

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
  await app.register(venueImageRoutes);
  await app.register(arenaRoutes);
  await app.register(bookingRoutes);
  await app.register(slotRoutes);
  await app.register(pricingRoutes);
  // Track B (Phases 11–17). Stubs throw at handler-time; routes mount so
  // OpenAPI / route-existence probes pass.
  await app.register(paymentRoutes);
  await app.register(razorpayWebhookRoutes);
  await app.register(eventRoutes);
  await app.register(eventImageRoutes);
  await app.register(membershipRoutes);
  await app.register(apiKeyRoutes);
  await app.register(webhookSubscriptionRoutes);
  await app.register(notificationRoutes);
  // Team management.
  await app.register(invitationRoutes);
  await app.register(teamRoutes);
  // Phase 14: cancellations + admin refunds.
  await app.register(cancellationRoutes);
  await app.register(adminRefundRoutes);
  // Phase 16: platform-admin endpoints (gated via assertCap + getPlatformTenantId).
  await app.register(adminTenantRoutes);
  await app.register(adminPayoutRoutes);
  await app.register(adminListingRoutes);
  await app.register(adminAuditLogRoutes);
  // Phase 17: public aggregator API (Bearer ck_… auth, channel='aggregator').
  await app.register(publicBookingRoutes);
  // Subproject E: consumer portal API (public browse + authed consumer booking).
  await app.register(consumerRoutes);
  // UX issue #20: partner support issues + admin support inbox.
  await app.register(supportIssueRoutes);

  return app;
}
