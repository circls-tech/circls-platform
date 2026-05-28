import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { BadRequest, NotFound } from '../lib/errors.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
import { requireTenantMembership } from '../middleware/tenant_context.js';
import {
  createEvent,
  getEvent,
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
  arenaIds: z.array(z.string().uuid()).min(1),
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
    return createEvent({
      tenantId: venue.tenantId,
      venueId,
      name: parsed.data.name,
      description: parsed.data.description,
      startsAt: new Date(parsed.data.startsAt),
      endsAt: new Date(parsed.data.endsAt),
      pricePaise: parsed.data.pricePaise,
      capacity: parsed.data.capacity,
      arenaIds: parsed.data.arenaIds,
    });
  });

  app.get('/v1/tenants/:tenantId/events/:id', { preHandler: requireAuth }, async (req) => {
    const { tenantId, id } = req.params as { tenantId: string; id: string };
    const user = await currentUser(req);
    await requireTenantMembership(user.id, tenantId);
    const row = await getEvent(id, tenantId);
    if (!row) throw new NotFound('Event not found', 'event_not_found');
    return row;
  });

  app.patch('/v1/tenants/:tenantId/events/:id', { preHandler: requireAuth }, async (req) => {
    const { tenantId, id } = req.params as { tenantId: string; id: string };
    const user = await currentUser(req);
    await requireTenantMembership(user.id, tenantId);
    return updateEvent(id, req.body as Record<string, unknown>);
  });

  app.post(
    '/v1/tenants/:tenantId/events/:id/publish',
    { preHandler: requireAuth },
    async (req) => {
      const { tenantId, id } = req.params as { tenantId: string; id: string };
      const user = await currentUser(req);
      await requireTenantMembership(user.id, tenantId);
      return publishEvent(id);
    },
  );
};
