import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { env } from '../config/env.js';
import { slots } from '../db/schema/index.js';
import { BadRequest, NotFound } from '../lib/errors.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
import { requireTenantMembership } from '../middleware/tenant_context.js';
import { getArenaById } from '../services/arena_service.js';
import { getVenueById } from '../services/venue_service.js';
import {
  releaseSlots,
  listSlots,
  bulkUpdateSlots,
  holdSlots,
  releaseHold,
} from '../services/slot_service.js';
import { withIdempotency } from '../lib/idempotency.js';

/** Resolve an arena → its venue's tenant, assert the caller is a member. */
async function authorizeArena(req: FastifyRequest, arenaId: string) {
  const arena = await getArenaById(arenaId);
  if (!arena) throw new NotFound('Arena not found', 'arena_not_found');
  const venue = await getVenueById(arena.venueId);
  if (!venue) throw new NotFound('Venue not found', 'venue_not_found');
  const user = await currentUser(req);
  await requireTenantMembership(user.id, venue.tenantId);
  return { user, venue, arena };
}

const scheduleTemplateSchema = z.object({
  quantizationMin: z.number().int().positive(),
  defaultPriceRupees: z.number().int().nonnegative(),
  bands: z
    .array(
      z.object({
        startMin: z.number().int().min(0).max(1439),
        endMin: z.number().int().min(0).max(1439),
        priceRupees: z.number().int().nonnegative(),
      }),
    )
    .max(48),
});

const releaseSlotsSchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'Must be YYYY-MM-DD date or datetime'),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'Must be YYYY-MM-DD date or datetime'),
  quantizationMin: z.number().int().positive(),
  // Business-day boundary (minute-of-day, 0..1439) to persist on the arena.
  businessDayStartMin: z.number().int().min(0).max(1439).optional(),
  // Last-used builder template to persist on the arena for prefill.
  template: scheduleTemplateSchema.optional(),
  cells: z.array(
    z.object({
      dayOfWeek: z.number().int().min(0).max(6),
      startTimeMin: z.number().int().nonnegative(),
      durationMin: z.number().int().positive(),
      price: z.number().int().nonnegative().nullable().optional(),
      blocked: z.boolean().optional(),
    }),
  ),
});

const bulkUpdateSchema = z.object({
  slotIds: z.array(z.string().uuid()).min(1),
  price: z.number().int().nonnegative().optional(),
  blocked: z.boolean().optional(),
});

const slotIdsSchema = z.object({
  slotIds: z.array(z.string().uuid()).min(1),
});

export const slotRoutes: FastifyPluginAsync = async (app) => {
  // POST /v1/arenas/:arenaId/slots/release
  app.post('/v1/arenas/:arenaId/slots/release', { preHandler: requireAuth }, async (req, reply) => {
    const { arenaId } = req.params as { arenaId: string };

    const idemKey = req.headers['idempotency-key'];
    if (typeof idemKey !== 'string' || idemKey.length < 8) {
      throw new BadRequest('Idempotency-Key header required', 'idempotency_key_required');
    }

    const parsed = releaseSlotsSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequest('Invalid release payload', 'bad_request', { issues: parsed.error.issues });
    }

    const { user, venue } = await authorizeArena(req, arenaId);
    const { tenantId } = venue;
    const input = parsed.data;

    const result = await withIdempotency(idemKey, tenantId, async () => ({
      status: 200,
      body: await releaseSlots(
        { tenantId, actorUserId: user.id },
        arenaId,
        {
          startDate: input.startDate,
          endDate: input.endDate,
          quantizationMin: input.quantizationMin,
          ...(input.businessDayStartMin !== undefined
            ? { businessDayStartMin: input.businessDayStartMin }
            : {}),
          ...(input.template !== undefined ? { template: input.template } : {}),
          cells: input.cells.map((c) => ({
            dayOfWeek: c.dayOfWeek,
            startTimeMin: c.startTimeMin,
            durationMin: c.durationMin,
            ...(c.price !== undefined ? { price: c.price } : {}),
            ...(c.blocked !== undefined ? { blocked: c.blocked } : {}),
          })),
        },
      ),
    }));

    return reply.status(result.status).send(result.body);
  });

  // GET /v1/arenas/:arenaId/slots?from&to
  app.get('/v1/arenas/:arenaId/slots', { preHandler: requireAuth }, async (req) => {
    const { arenaId } = req.params as { arenaId: string };
    const q = req.query as { from?: string; to?: string };
    await authorizeArena(req, arenaId);
    const from = q.from ?? new Date(Date.now() - 86_400_000).toISOString();
    const to = q.to ?? new Date(Date.now() + 30 * 86_400_000).toISOString();
    return listSlots(arenaId, from, to);
  });

  // PATCH /v1/slots/bulk
  app.patch('/v1/slots/bulk', { preHandler: requireAuth }, async (req) => {
    const parsed = bulkUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequest('Invalid bulk update payload', 'bad_request', { issues: parsed.error.issues });
    }
    const { slotIds, price, blocked } = parsed.data;

    // Resolve tenant from the first slot
    const firstSlot = await db
      .select()
      .from(slots)
      .where(and(eq(slots.id, slotIds[0]!), sql`${slots.deletedAt} is null`))
      .limit(1);

    if (firstSlot.length === 0) throw new NotFound('Slot not found', 'slot_not_found');

    const arena = await getArenaById(firstSlot[0]!.arenaId);
    if (!arena) throw new NotFound('Arena not found', 'arena_not_found');
    const venue = await getVenueById(arena.venueId);
    if (!venue) throw new NotFound('Venue not found', 'venue_not_found');

    const user = await currentUser(req);
    await requireTenantMembership(user.id, venue.tenantId);

    const patch: { price?: number; blocked?: boolean } = {};
    if (price !== undefined) patch.price = price;
    if (blocked !== undefined) patch.blocked = blocked;

    return bulkUpdateSlots(
      { tenantId: venue.tenantId, actorUserId: user.id },
      slotIds,
      patch,
    );
  });

  // POST /v1/slots/hold
  // Holds reserve inventory → stricter public ceiling (M6 rate limiting).
  app.post('/v1/slots/hold', {
    preHandler: requireAuth,
    config: { rateLimit: { max: env.RATE_LIMIT_PUBLIC_MAX, timeWindow: '1 minute' } },
  }, async (req) => {
    const parsed = slotIdsSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequest('Invalid hold payload', 'bad_request', { issues: parsed.error.issues });
    }
    const { slotIds } = parsed.data;

    // Authorize via first slot
    const firstSlot = await db
      .select()
      .from(slots)
      .where(and(eq(slots.id, slotIds[0]!), sql`${slots.deletedAt} is null`))
      .limit(1);

    if (firstSlot.length === 0) throw new NotFound('Slot not found', 'slot_not_found');

    const arena = await getArenaById(firstSlot[0]!.arenaId);
    if (!arena) throw new NotFound('Arena not found', 'arena_not_found');
    const venue = await getVenueById(arena.venueId);
    if (!venue) throw new NotFound('Venue not found', 'venue_not_found');

    const user = await currentUser(req);
    await requireTenantMembership(user.id, venue.tenantId);

    await holdSlots(venue.tenantId, user.id, slotIds);
    return { held: slotIds.length };
  });

  // POST /v1/slots/release-hold
  app.post('/v1/slots/release-hold', { preHandler: requireAuth }, async (req) => {
    const parsed = slotIdsSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequest('Invalid release-hold payload', 'bad_request', { issues: parsed.error.issues });
    }
    const { slotIds } = parsed.data;

    // Authorize via first slot
    const firstSlot = await db
      .select()
      .from(slots)
      .where(and(eq(slots.id, slotIds[0]!), sql`${slots.deletedAt} is null`))
      .limit(1);

    if (firstSlot.length === 0) throw new NotFound('Slot not found', 'slot_not_found');

    const arena = await getArenaById(firstSlot[0]!.arenaId);
    if (!arena) throw new NotFound('Arena not found', 'arena_not_found');
    const venue = await getVenueById(arena.venueId);
    if (!venue) throw new NotFound('Venue not found', 'venue_not_found');

    const user = await currentUser(req);
    await requireTenantMembership(user.id, venue.tenantId);

    await releaseHold(venue.tenantId, slotIds);
    return { released: slotIds.length };
  });
};
