import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { BadRequest, NotFound } from '../lib/errors.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
import { requireTenantMembership } from '../middleware/tenant_context.js';
import { createArena, getArenaById, listArenas } from '../services/arena_service.js';
import { getWeeklySchedule, setWeeklySchedule } from '../services/schedule_service.js';
import { getVenueById } from '../services/venue_service.js';

const createArenaSchema = z.object({
  name: z.string().min(1).max(200),
  sport: z.string().max(80).optional(),
  capacity: z.number().int().positive().optional(),
  slotDurationMin: z.number().int().min(5).max(1440).optional(),
  tags: z.array(z.string().min(1).max(40)).max(20).optional(),
});
const timeRe = /^\d{2}:\d{2}(:\d{2})?$/;
const scheduleSchema = z.object({
  rows: z.array(
    z.object({
      dayOfWeek: z.number().int().min(0).max(6),
      startTime: z.string().regex(timeRe),
      endTime: z.string().regex(timeRe),
      slotDurationMin: z.number().int().min(5).max(1440).optional(),
    }),
  ),
});

/** Resolve an arena → its venue's tenant and assert the caller is a member. */
async function authorizeArena(req: FastifyRequest, arenaId: string) {
  const arena = await getArenaById(arenaId);
  if (!arena) throw new NotFound('Arena not found', 'arena_not_found');
  const venue = await getVenueById(arena.venueId);
  if (!venue) throw new NotFound('Venue not found', 'venue_not_found');
  const user = await currentUser(req);
  await requireTenantMembership(user.id, venue.tenantId);
  return arena;
}

export const arenaRoutes: FastifyPluginAsync = async (app) => {
  app.post('/v1/venues/:venueId/arenas', { preHandler: requireAuth }, async (req) => {
    const { venueId } = req.params as { venueId: string };
    const parsed = createArenaSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequest('Invalid arena payload', 'bad_request', { issues: parsed.error.issues });
    }
    const venue = await getVenueById(venueId);
    if (!venue) throw new NotFound('Venue not found', 'venue_not_found');
    const user = await currentUser(req);
    await requireTenantMembership(user.id, venue.tenantId);
    const { name, sport, capacity, slotDurationMin, tags } = parsed.data;
    return createArena(venueId, {
      name,
      sport: sport ?? null,
      capacity: capacity ?? null,
      tags: tags ?? [],
      ...(slotDurationMin !== undefined ? { slotDurationMin } : {}),
    });
  });

  app.get('/v1/venues/:venueId/arenas', { preHandler: requireAuth }, async (req) => {
    const { venueId } = req.params as { venueId: string };
    const venue = await getVenueById(venueId);
    if (!venue) throw new NotFound('Venue not found', 'venue_not_found');
    const user = await currentUser(req);
    await requireTenantMembership(user.id, venue.tenantId);
    return listArenas(venueId);
  });

  app.get('/v1/arenas/:arenaId', { preHandler: requireAuth }, async (req) => {
    const { arenaId } = req.params as { arenaId: string };
    return authorizeArena(req, arenaId);
  });

  app.put('/v1/arenas/:arenaId/schedule', { preHandler: requireAuth }, async (req) => {
    const { arenaId } = req.params as { arenaId: string };
    const parsed = scheduleSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequest('Invalid schedule payload', 'bad_request', { issues: parsed.error.issues });
    }
    await authorizeArena(req, arenaId);
    return setWeeklySchedule(arenaId, parsed.data.rows);
  });

  app.get('/v1/arenas/:arenaId/schedule', { preHandler: requireAuth }, async (req) => {
    const { arenaId } = req.params as { arenaId: string };
    await authorizeArena(req, arenaId);
    return getWeeklySchedule(arenaId);
  });
};
