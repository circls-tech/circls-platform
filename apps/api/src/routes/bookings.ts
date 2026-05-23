import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { BadRequest, NotFound } from '../lib/errors.js';
import { withIdempotency } from '../lib/idempotency.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
import { requireTenantMembership } from '../middleware/tenant_context.js';
import { getArenaById } from '../services/arena_service.js';
import {
  cancelBooking,
  createSlotBooking,
  getBookingById,
  listArenaBookings,
} from '../services/inventory_service.js';
import { getVenueById } from '../services/venue_service.js';

const walkinSchema = z.object({
  tenantId: z.string().uuid(),
  venueId: z.string().uuid().optional(),
  arenaId: z.string().uuid(),
  startAt: z.string().datetime({ offset: true }),
  endAt: z.string().datetime({ offset: true }),
  pricePaise: z.number().int().nonnegative().optional(),
  customerContact: z.record(z.unknown()).optional(),
});

export const bookingRoutes: FastifyPluginAsync = async (app) => {
  // Walk-in (Channel D): created confirmed, paid externally (cash/UPI at counter).
  app.post('/v1/bookings', { preHandler: requireAuth }, async (req, reply) => {
    const idemKey = req.headers['idempotency-key'];
    if (typeof idemKey !== 'string' || idemKey.length < 8) {
      throw new BadRequest('Idempotency-Key header required', 'idempotency_key_required');
    }
    const parsed = walkinSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequest('Invalid booking payload', 'bad_request', { issues: parsed.error.issues });
    }
    const { tenantId, arenaId, startAt, endAt, pricePaise, customerContact } = parsed.data;
    if (new Date(startAt).getTime() >= new Date(endAt).getTime()) {
      throw new BadRequest('startAt must be before endAt', 'bad_time_range');
    }
    const user = await currentUser(req);
    await requireTenantMembership(user.id, tenantId);

    // The arena must belong to this tenant (resolved via its venue).
    const arena = await getArenaById(arenaId);
    if (!arena) throw new NotFound('Arena not found', 'arena_not_found');
    const venue = await getVenueById(arena.venueId);
    if (!venue || venue.tenantId !== tenantId) {
      throw new BadRequest('Arena does not belong to this tenant', 'arena_mismatch');
    }

    const result = await withIdempotency(idemKey, tenantId, async () => {
      const booking = await createSlotBooking({
        tenantId,
        venueId: venue.id,
        arenaId,
        startAt,
        endAt,
        channel: 'walkin',
        paymentMethod: 'external',
        status: 'confirmed',
        pricePaise: pricePaise ?? null,
        customerContact: customerContact ?? null,
        createdByUserId: user.id,
      });
      return { status: 201, body: booking };
    });
    return reply.status(result.status).send(result.body);
  });

  // Cancel — frees the slot (GIST constraint excludes cancelled rows).
  app.post('/v1/bookings/:id/cancel', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const booking = await getBookingById(id);
    if (!booking) throw new NotFound('Booking not found', 'booking_not_found');
    const user = await currentUser(req);
    await requireTenantMembership(user.id, booking.tenantId);
    return cancelBooking(booking.tenantId, id);
  });

  // Day grid for the reception dashboard.
  app.get('/v1/arenas/:arenaId/bookings', { preHandler: requireAuth }, async (req) => {
    const { arenaId } = req.params as { arenaId: string };
    const q = req.query as { from?: string; to?: string };
    const arena = await getArenaById(arenaId);
    if (!arena) throw new NotFound('Arena not found', 'arena_not_found');
    const venue = await getVenueById(arena.venueId);
    if (!venue) throw new NotFound('Venue not found', 'venue_not_found');
    const user = await currentUser(req);
    await requireTenantMembership(user.id, venue.tenantId);
    const from = q.from ?? new Date(Date.now() - 86_400_000).toISOString();
    const to = q.to ?? new Date(Date.now() + 7 * 86_400_000).toISOString();
    return listArenaBookings(arenaId, from, to);
  });
};
