import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { BadRequest, NotFound } from '../lib/errors.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
import { requireTenantMembership } from '../middleware/tenant_context.js';
import { getArenaById } from '../services/arena_service.js';
import {
  createPricingRule,
  deletePricingRule,
  listPricingRules,
} from '../services/pricing_service.js';
import { getVenueById } from '../services/venue_service.js';

const ruleSchema = z.object({
  priority: z.number().int().optional(),
  dayOfWeek: z.number().int().min(0).max(6).nullable().optional(),
  startTimeMin: z.number().int().min(0).max(1440).nullable().optional(),
  startTimeMax: z.number().int().min(0).max(1440).nullable().optional(),
  channel: z.enum(['circls', 'aggregator', 'venue_site', 'walkin']).nullable().optional(),
  memberOnly: z.boolean().optional(),
  pricePaise: z.number().int().nonnegative(),
});

async function authorizeArena(req: FastifyRequest, arenaId: string): Promise<void> {
  const arena = await getArenaById(arenaId);
  if (!arena) throw new NotFound('Arena not found', 'arena_not_found');
  const venue = await getVenueById(arena.venueId);
  if (!venue) throw new NotFound('Venue not found', 'venue_not_found');
  const user = await currentUser(req);
  await requireTenantMembership(user.id, venue.tenantId);
}

export const pricingRoutes: FastifyPluginAsync = async (app) => {
  app.post('/v1/arenas/:arenaId/pricing-rules', { preHandler: requireAuth }, async (req) => {
    const { arenaId } = req.params as { arenaId: string };
    const parsed = ruleSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequest('Invalid pricing rule', 'bad_request', { issues: parsed.error.issues });
    }
    await authorizeArena(req, arenaId);
    const p = parsed.data;
    return createPricingRule(arenaId, {
      ...(p.priority !== undefined ? { priority: p.priority } : {}),
      ...(p.dayOfWeek !== undefined ? { dayOfWeek: p.dayOfWeek } : {}),
      ...(p.startTimeMin !== undefined ? { startTimeMin: p.startTimeMin } : {}),
      ...(p.startTimeMax !== undefined ? { startTimeMax: p.startTimeMax } : {}),
      ...(p.channel !== undefined ? { channel: p.channel } : {}),
      ...(p.memberOnly !== undefined ? { memberOnly: p.memberOnly } : {}),
      pricePaise: p.pricePaise,
    });
  });

  app.get('/v1/arenas/:arenaId/pricing-rules', { preHandler: requireAuth }, async (req) => {
    const { arenaId } = req.params as { arenaId: string };
    await authorizeArena(req, arenaId);
    return listPricingRules(arenaId);
  });

  app.delete(
    '/v1/arenas/:arenaId/pricing-rules/:ruleId',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { arenaId, ruleId } = req.params as { arenaId: string; ruleId: string };
      await authorizeArena(req, arenaId);
      await deletePricingRule(arenaId, ruleId);
      return reply.status(204).send();
    },
  );
};
