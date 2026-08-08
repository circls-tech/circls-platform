import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { env } from '../config/env.js';
import { BadRequest } from '../lib/errors.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
import {
  getFeedbackPrompt,
  submitEventFeedback,
  submitEventTypePreference,
} from '../services/feedback_service.js';

const feedbackBody = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('event_feedback'),
    eventId: z.string().uuid(),
    rating: z.number().int().min(1).max(5),
    comment: z.string().max(2000).optional(),
    source: z.string().max(40).optional(),
  }),
  z.object({
    kind: z.literal('event_type_preference'),
    questionKey: z.string().min(1).max(64),
    answer: z.string().min(1).max(200),
    source: z.string().max(40).optional(),
  }),
]);

/**
 * Post-login consumer feedback (consumer portal + mobile app): the server
 * decides which prompt a signed-in consumer should see — "how was <event>"
 * for an unreviewed past registration, or a random event-type MCQ for users
 * with no bookings — and records the answer against the user + their phone
 * number (see feedback_service / user_feedback schema).
 */
export const feedbackRoutes: FastifyPluginAsync = async (app) => {
  const publicLimit = {
    rateLimit: { max: env.RATE_LIMIT_PUBLIC_MAX, timeWindow: '1 minute' },
  } as const;

  app.get('/v1/consumer/feedback/prompt', { preHandler: requireAuth }, async (req) => {
    const user = await currentUser(req);
    return { prompt: await getFeedbackPrompt(user.id) };
  });

  app.post(
    '/v1/consumer/feedback',
    { preHandler: requireAuth, config: publicLimit },
    async (req) => {
      const user = await currentUser(req);
      const parsed = feedbackBody.safeParse(req.body);
      if (!parsed.success) {
        throw new BadRequest('Invalid feedback payload', 'bad_request', {
          issues: parsed.error.issues,
        });
      }
      const data = parsed.data;
      const feedback =
        data.kind === 'event_feedback'
          ? await submitEventFeedback(user, {
              eventId: data.eventId,
              rating: data.rating,
              ...(data.comment !== undefined && { comment: data.comment }),
              ...(data.source !== undefined && { source: data.source }),
            })
          : await submitEventTypePreference(user, {
              questionKey: data.questionKey,
              answer: data.answer,
              ...(data.source !== undefined && { source: data.source }),
            });
      return { feedback };
    },
  );
};
