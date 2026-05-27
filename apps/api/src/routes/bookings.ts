import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { BadRequest, NotFound } from '../lib/errors.js';
import { withIdempotency } from '../lib/idempotency.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
import { requireTenantMembership } from '../middleware/tenant_context.js';
import { getArenaById } from '../services/arena_service.js';
import { getVenueById } from '../services/venue_service.js';
import { getBookingById } from '../services/inventory_service.js';
import { bookSlots, cancelBooking } from '../services/booking_service.js';
import { getBookingDetail, listBookings } from '../services/bookings_read_service.js';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { slots } from '../db/schema/index.js';

const bookSlotsSchema = z.object({
  slotIds: z.array(z.string().uuid()).min(1),
  customer: z.object({
    name: z.string().min(1),
    contact: z.string().min(1),
    note: z.string().optional(),
  }),
});

const listBookingsQuerySchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
  arenaId: z.string().uuid().optional(),
  status: z.enum(['pending', 'confirmed', 'cancelled', 'completed', 'no_show']).optional(),
  q: z.string().optional(),
});

export const bookingRoutes: FastifyPluginAsync = async (app) => {
  // Multi-slot walk-in booking (Channel D): created confirmed, paid externally.
  app.post('/v1/bookings', { preHandler: requireAuth }, async (req, reply) => {
    const idemKey = req.headers['idempotency-key'];
    if (typeof idemKey !== 'string' || idemKey.length < 8) {
      throw new BadRequest('Idempotency-Key header required', 'idempotency_key_required');
    }

    const parsed = bookSlotsSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequest('Invalid booking payload', 'bad_request', { issues: parsed.error.issues });
    }
    const { slotIds, customer } = parsed.data;

    // Resolve venue/tenant from the first slot
    const firstSlotRows = await db
      .select()
      .from(slots)
      .where(eq(slots.id, slotIds[0]!))
      .limit(1);

    if (firstSlotRows.length === 0) throw new NotFound('Slot not found', 'slot_not_found');

    const arena = await getArenaById(firstSlotRows[0]!.arenaId);
    if (!arena) throw new NotFound('Arena not found', 'arena_not_found');

    const venue = await getVenueById(arena.venueId);
    if (!venue) throw new NotFound('Venue not found', 'venue_not_found');

    const user = await currentUser(req);
    const { tenantId } = venue;
    await requireTenantMembership(user.id, tenantId);

    const result = await withIdempotency(idemKey, tenantId, async () => ({
      status: 201,
      body: await bookSlots(
        { tenantId, actorUserId: user.id },
        venue.id,
        {
          slotIds,
          customerName: customer.name,
          customerContact: customer.contact,
          note: customer.note ?? null,
        },
      ),
    }));

    return reply.status(result.status).send(result.body);
  });

  // List a venue's bookings overlapping a [from,to) window, with optional filters.
  app.get('/v1/venues/:venueId/bookings', { preHandler: requireAuth }, async (req) => {
    const { venueId } = req.params as { venueId: string };
    const parsed = listBookingsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new BadRequest('Invalid bookings query', 'bad_request', { issues: parsed.error.issues });
    }
    const venue = await getVenueById(venueId);
    if (!venue) throw new NotFound('Venue not found', 'venue_not_found');
    const user = await currentUser(req);
    await requireTenantMembership(user.id, venue.tenantId);

    const { from, to, arenaId, status, q } = parsed.data;
    return listBookings(venue.tenantId, venueId, {
      fromIso: from,
      toIso: to,
      ...(arenaId !== undefined ? { arenaId } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(q !== undefined ? { q } : {}),
    });
  });

  // Single booking detail (with its non-deleted slots).
  app.get('/v1/bookings/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const booking = await getBookingById(id);
    if (!booking) throw new NotFound('Booking not found', 'booking_not_found');
    const user = await currentUser(req);
    await requireTenantMembership(user.id, booking.tenantId);
    return getBookingDetail(booking.tenantId, id);
  });

  // Cancel — frees the slots back to open.
  app.post('/v1/bookings/:id/cancel', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const booking = await getBookingById(id);
    if (!booking) throw new NotFound('Booking not found', 'booking_not_found');
    const user = await currentUser(req);
    await requireTenantMembership(user.id, booking.tenantId);
    return cancelBooking({ tenantId: booking.tenantId, actorUserId: user.id }, id);
  });

};

