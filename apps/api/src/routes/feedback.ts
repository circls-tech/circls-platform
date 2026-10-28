import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env } from '../config/env.js';
import type { User } from '../db/schema/users.js';
import { BadRequest } from '../lib/errors.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
import { requireTenantMembership } from '../middleware/tenant_context.js';
import {
  CONSUMER_SOURCES,
  dismissConsumerPrompt,
  dismissPartnerPrompt,
  getFeedbackPrompt,
  getPartnerFeedbackPrompt,
  PARTNER_SOURCES,
  RATING_MAX,
  RATING_MIN,
  submitConsumerSiteFeedback,
  submitEventTypePreference,
  submitPartnerSiteFeedback,
  submitRating,
} from '../services/feedback_service.js';

const rating = z.number().int().min(RATING_MIN).max(RATING_MAX);
/** An area rating; null = "Haven't tried yet". */
const areaRating = rating.nullable().optional();
const note = z.string().max(2000).optional();
/** The submitting client (see CONSUMER_SOURCES / PARTNER_SOURCES). */
const source = z.enum(CONSUMER_SOURCES).optional();
const partnerSource = z.enum(PARTNER_SOURCES).optional();

const ratingBody = (kind: 'event_feedback' | 'venue_feedback' | 'membership_feedback') =>
  z.object({ kind: z.literal(kind), id: z.string().uuid(), rating, comment: note, source });

const consumerBody = z.discriminatedUnion('kind', [
  ratingBody('event_feedback'),
  ratingBody('venue_feedback'),
  ratingBody('membership_feedback'),
  z.object({
    kind: z.literal('event_type_preference'),
    questionKey: z.string().min(1).max(64),
    answer: z.string().min(1).max(200),
    /** What they typed when they chose "Other". */
    other: z.string().max(200).optional(),
    source,
  }),
  z.object({
    kind: z.literal('site_feedback'),
    overallRating: rating,
    discoveryRating: areaRating,
    bookingRating: areaRating,
    challenges: note,
    comments: note,
    source,
  }),
]);

const partnerBody = z.object({
  overallRating: rating,
  eventCreationRating: areaRating,
  venueCreationRating: areaRating,
  membershipCreationRating: areaRating,
  challenges: note,
  comments: note,
  source: partnerSource,
});

const dismissBody = z.object({ key: z.string().min(1).max(80) });

/**
 * Answers snapshot the person's phone. When their users row has none yet (a
 * phone sign-in whose row predates it), take the verified one on the token.
 */
function withTokenPhone(user: User, req: FastifyRequest): User {
  if (user.phoneE164) return user;
  return { ...user, phoneE164: req.authUser?.phoneE164 ?? null };
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new BadRequest('Invalid feedback payload', 'bad_request', {
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}

/**
 * Feedback prompts (see feedback_service): the server decides what a signed-in
 * consumer or partner should be asked — a 1–10 rating of something they
 * booked, PR #171's event-type poll, or the website survey — and records the
 * answer against the person and their phone number. "Not now" is recorded
 * here too, so the weekly nudge follows people across devices.
 */
export const feedbackRoutes: FastifyPluginAsync = async (app) => {
  const publicLimit = {
    rateLimit: { max: env.RATE_LIMIT_PUBLIC_MAX, timeWindow: '1 minute' },
  } as const;

  app.get('/v1/consumer/feedback/prompt', { preHandler: requireAuth }, async (req) => {
    const user = await currentUser(req);
    return { prompt: await getFeedbackPrompt(user) };
  });

  app.post(
    '/v1/consumer/feedback',
    { preHandler: requireAuth, config: publicLimit },
    async (req) => {
      const user = withTokenPhone(await currentUser(req), req);
      const data = parse(consumerBody, req.body);
      switch (data.kind) {
        case 'event_type_preference':
          return { feedback: await submitEventTypePreference(user, data) };
        case 'site_feedback':
          return { feedback: await submitConsumerSiteFeedback(user, data) };
        default:
          return { feedback: await submitRating(user, data) };
      }
    },
  );

  app.post(
    '/v1/consumer/feedback/dismiss',
    { preHandler: requireAuth, config: publicLimit },
    async (req) => {
      const user = await currentUser(req);
      await dismissConsumerPrompt(user.id, parse(dismissBody, req.body).key);
      return { ok: true };
    },
  );

  // ── Partner portal: the platform survey, once per organisation ──────────────

  app.get('/v1/tenants/:tenantId/feedback/prompt', { preHandler: requireAuth }, async (req) => {
    const { tenantId } = req.params as { tenantId: string };
    const user = await currentUser(req);
    const ctx = await requireTenantMembership(user.id, tenantId);
    return { prompt: await getPartnerFeedbackPrompt(user.id, ctx) };
  });

  app.post(
    '/v1/tenants/:tenantId/feedback',
    { preHandler: requireAuth, config: publicLimit },
    async (req) => {
      const { tenantId } = req.params as { tenantId: string };
      const user = withTokenPhone(await currentUser(req), req);
      const ctx = await requireTenantMembership(user.id, tenantId);
      const data = parse(partnerBody, req.body);
      return { feedback: await submitPartnerSiteFeedback(user, ctx, data) };
    },
  );

  app.post(
    '/v1/tenants/:tenantId/feedback/dismiss',
    { preHandler: requireAuth, config: publicLimit },
    async (req) => {
      const { tenantId } = req.params as { tenantId: string };
      const user = await currentUser(req);
      const ctx = await requireTenantMembership(user.id, tenantId);
      await dismissPartnerPrompt(user.id, ctx);
      return { ok: true };
    },
  );
};
