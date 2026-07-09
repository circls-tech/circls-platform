import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { BadRequest } from '../lib/errors.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
import { requireTenantMembership } from '../middleware/tenant_context.js';
import {
  getActivityDailyCounts,
  listActivity,
  listMembershipWindows,
} from '../services/activity_service.js';

const feedQuerySchema = z.object({
  type: z.enum(['slot', 'event', 'membership']).optional(),
  venueId: z.string().uuid().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  q: z.string().optional(),
  sessionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'sessionDate must be YYYY-MM-DD').optional(),
  tz: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const dailyQuerySchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month must be YYYY-MM'),
  tz: z.string().default('Asia/Kolkata'),
  venueId: z.string().uuid().optional(),
});

const membershipWindowsQuerySchema = z.object({
  withinDays: z.coerce.number().int().min(1).max(90).default(30),
});

/** Reject tz names Postgres would choke on with a 400 instead of a 500. */
function assertValidTimezone(tz: string): void {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
  } catch {
    throw new BadRequest('Invalid timezone', 'invalid_timezone');
  }
}

/**
 * Tenant activity feed (partner portal "Activity" page): a unified,
 * cursor-paginated view of slot bookings, event registrations and membership
 * purchases, plus per-day booking counts for the calendar and membership
 * start/end windows. Read-only — tenant membership is the only requirement.
 */
export const activityRoutes: FastifyPluginAsync = async (app) => {
  app.get('/v1/tenants/:tenantId/activity', { preHandler: requireAuth }, async (req) => {
    const { tenantId } = req.params as { tenantId: string };
    const user = await currentUser(req);
    await requireTenantMembership(user.id, tenantId);

    const parsed = feedQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new BadRequest('Invalid activity query', 'bad_request', { issues: parsed.error.issues });
    }
    const { type, venueId, from, to, q, sessionDate, tz, cursor, limit } = parsed.data;
    if (tz !== undefined) assertValidTimezone(tz);
    return listActivity(tenantId, {
      ...(type !== undefined && { type }),
      ...(venueId !== undefined && { venueId }),
      ...(from !== undefined && { from }),
      ...(to !== undefined && { to }),
      ...(q !== undefined && { q }),
      ...(sessionDate !== undefined && { sessionDate }),
      ...(tz !== undefined && { tz }),
      ...(cursor !== undefined && { cursor }),
      ...(limit !== undefined && { limit }),
    });
  });

  app.get('/v1/tenants/:tenantId/activity/daily', { preHandler: requireAuth }, async (req) => {
    const { tenantId } = req.params as { tenantId: string };
    const user = await currentUser(req);
    await requireTenantMembership(user.id, tenantId);

    const parsed = dailyQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new BadRequest('Invalid daily activity query', 'bad_request', {
        issues: parsed.error.issues,
      });
    }
    const { month, tz, venueId } = parsed.data;
    assertValidTimezone(tz);
    return getActivityDailyCounts(tenantId, {
      month,
      tz,
      ...(venueId !== undefined && { venueId }),
    });
  });

  app.get(
    '/v1/tenants/:tenantId/activity/membership-windows',
    { preHandler: requireAuth },
    async (req) => {
      const { tenantId } = req.params as { tenantId: string };
      const user = await currentUser(req);
      await requireTenantMembership(user.id, tenantId);

      const parsed = membershipWindowsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new BadRequest('Invalid membership windows query', 'bad_request', {
          issues: parsed.error.issues,
        });
      }
      return listMembershipWindows(tenantId, parsed.data.withinDays);
    },
  );
};
