import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { BadRequest, NotFound } from '../lib/errors.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
import { requireTenantMembership } from '../middleware/tenant_context.js';
import {
  cancelEvent,
  createEvent,
  getEvent,
  listEventBookings,
  listEventsForTenant,
  listEventsForVenue,
  publishEvent,
  updateEvent,
} from '../services/events_service.js';
import { getVenueById } from '../services/venue_service.js';

const createEventSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  pricePaise: z.number().int().min(0),
  capacity: z.number().int().min(1).optional(),
});

const createTenantEventSchema = z
  .object({
    venueId: z.string().uuid().optional(),
    addressJson: z.record(z.unknown()).optional(),
    lat: z.number().optional(),
    lng: z.number().optional(),
    tzName: z.string().min(1).optional(),
    name: z.string().min(1).max(200),
    description: z.string().optional(),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
    pricePaise: z.number().int().min(0),
    capacity: z.number().int().min(1).optional(),
  })
  // Exactly one scope: a venue OR a standalone address (never both, never neither).
  .refine((d) => Boolean(d.venueId) !== Boolean(d.addressJson), {
    message: 'Provide exactly one of venueId or addressJson',
  })
  .refine((d) => Boolean(d.venueId) || Boolean(d.tzName), {
    message: 'Standalone events require tzName',
  });

const updateEventSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().nullable().optional(),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().optional(),
  pricePaise: z.number().int().min(0).optional(),
  capacity: z.number().int().min(1).nullable().optional(),
});

export const eventRoutes: FastifyPluginAsync = async (app) => {
  app.get('/v1/venues/:venueId/events', { preHandler: requireAuth }, async (req) => {
    const { venueId } = req.params as { venueId: string };
    const venue = await getVenueById(venueId);
    if (!venue) throw new NotFound('Venue not found', 'venue_not_found');
    const user = await currentUser(req);
    await requireTenantMembership(user.id, venue.tenantId);
    return listEventsForVenue(venueId);
  });

  app.post('/v1/venues/:venueId/events', { preHandler: requireAuth }, async (req) => {
    const { venueId } = req.params as { venueId: string };
    const venue = await getVenueById(venueId);
    if (!venue) throw new NotFound('Venue not found', 'venue_not_found');
    const user = await currentUser(req);
    await requireTenantMembership(user.id, venue.tenantId);
    const parsed = createEventSchema.safeParse(req.body);
    if (!parsed.success)
      throw new BadRequest('Invalid event payload', 'bad_request', {
        issues: parsed.error.issues,
      });
    return createEvent(
      { tenantId: venue.tenantId, actorUserId: user.id },
      {
        tenantId: venue.tenantId,
        venueId,
        name: parsed.data.name,
        description: parsed.data.description,
        startsAt: new Date(parsed.data.startsAt),
        endsAt: new Date(parsed.data.endsAt),
        pricePaise: parsed.data.pricePaise,
        capacity: parsed.data.capacity,
      },
    );
  });

  app.get('/v1/tenants/:tenantId/events/:id', { preHandler: requireAuth }, async (req) => {
    const { tenantId, id } = req.params as { tenantId: string; id: string };
    const user = await currentUser(req);
    await requireTenantMembership(user.id, tenantId);
    const row = await getEvent(id, tenantId);
    if (!row) throw new NotFound('Event not found', 'event_not_found');
    return row;
  });

  app.get('/v1/tenants/:tenantId/events', { preHandler: requireAuth }, async (req) => {
    const { tenantId } = req.params as { tenantId: string };
    const user = await currentUser(req);
    await requireTenantMembership(user.id, tenantId);
    return listEventsForTenant(tenantId);
  });

  app.post('/v1/tenants/:tenantId/events', { preHandler: requireAuth }, async (req) => {
    const { tenantId } = req.params as { tenantId: string };
    const user = await currentUser(req);
    await requireTenantMembership(user.id, tenantId);
    const parsed = createTenantEventSchema.safeParse(req.body);
    if (!parsed.success)
      throw new BadRequest('Invalid event payload', 'bad_request', {
        issues: parsed.error.issues,
      });

    // Venue-scoped: the venue must belong to this tenant.
    if (parsed.data.venueId) {
      const venue = await getVenueById(parsed.data.venueId);
      if (!venue || venue.tenantId !== tenantId)
        throw new NotFound('Venue not found', 'venue_not_found');
    }

    return createEvent(
      { tenantId, actorUserId: user.id },
      {
        tenantId,
        venueId: parsed.data.venueId,
        addressJson: parsed.data.addressJson,
        lat: parsed.data.lat,
        lng: parsed.data.lng,
        tzName: parsed.data.tzName,
        name: parsed.data.name,
        description: parsed.data.description,
        startsAt: new Date(parsed.data.startsAt),
        endsAt: new Date(parsed.data.endsAt),
        pricePaise: parsed.data.pricePaise,
        capacity: parsed.data.capacity,
      },
    );
  });

  app.patch('/v1/tenants/:tenantId/events/:id', { preHandler: requireAuth }, async (req) => {
    const { tenantId, id } = req.params as { tenantId: string; id: string };
    const user = await currentUser(req);
    await requireTenantMembership(user.id, tenantId);
    const parsed = updateEventSchema.safeParse(req.body);
    if (!parsed.success)
      throw new BadRequest('Invalid event patch', 'bad_request', {
        issues: parsed.error.issues,
      });
    const patch: Parameters<typeof updateEvent>[2] = {};
    if (parsed.data.name !== undefined) patch.name = parsed.data.name;
    if (parsed.data.description !== undefined) patch.description = parsed.data.description;
    if (parsed.data.startsAt !== undefined) patch.startsAt = new Date(parsed.data.startsAt);
    if (parsed.data.endsAt !== undefined) patch.endsAt = new Date(parsed.data.endsAt);
    if (parsed.data.pricePaise !== undefined) patch.pricePaise = parsed.data.pricePaise;
    if (parsed.data.capacity !== undefined) patch.capacity = parsed.data.capacity;
    return updateEvent({ tenantId, actorUserId: user.id }, id, patch);
  });

  app.post(
    '/v1/tenants/:tenantId/events/:id/publish',
    { preHandler: requireAuth },
    async (req) => {
      const { tenantId, id } = req.params as { tenantId: string; id: string };
      const user = await currentUser(req);
      await requireTenantMembership(user.id, tenantId);
      return publishEvent({ tenantId, actorUserId: user.id }, id);
    },
  );

  app.post(
    '/v1/tenants/:tenantId/events/:id/cancel',
    { preHandler: requireAuth },
    async (req) => {
      const { tenantId, id } = req.params as { tenantId: string; id: string };
      const user = await currentUser(req);
      await requireTenantMembership(user.id, tenantId);
      return cancelEvent({ tenantId, actorUserId: user.id }, id);
    },
  );

  // Partner-facing: registrations for an event.
  app.get('/v1/tenants/:tenantId/events/:id/bookings', { preHandler: requireAuth }, async (req) => {
    const { tenantId, id } = req.params as { tenantId: string; id: string };
    const user = await currentUser(req);
    await requireTenantMembership(user.id, tenantId);
    return { rows: await listEventBookings(tenantId, id) };
  });
};
