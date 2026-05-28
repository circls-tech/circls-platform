import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { BadRequest, NotFound } from '../lib/errors.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
import { requireTenantMembership } from '../middleware/tenant_context.js';
import { createVenue, getVenueById, listVenues, updateVenue } from '../services/venue_service.js';

const createVenueSchema = z.object({
  name: z.string().min(1).max(200),
  tzName: z.string().min(1).max(64).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  addressJson: z.record(z.unknown()).optional(),
  tags: z.array(z.string().min(1).max(40)).max(20).optional(),
});
const updateVenueSchema = createVenueSchema.partial().extend({
  status: z.enum(['active', 'suspended']).optional(),
});

export const venueRoutes: FastifyPluginAsync = async (app) => {
  app.post('/v1/tenants/:tenantId/venues', { preHandler: requireAuth }, async (req) => {
    const { tenantId } = req.params as { tenantId: string };
    const parsed = createVenueSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequest('Invalid venue payload', 'bad_request', { issues: parsed.error.issues });
    }
    const user = await currentUser(req);
    await requireTenantMembership(user.id, tenantId);
    const { name, tzName, lat, lng, addressJson, tags } = parsed.data;
    return createVenue(tenantId, {
      name,
      tzName: tzName ?? 'Asia/Kolkata',
      lat: lat ?? null,
      lng: lng ?? null,
      addressJson: addressJson ?? null,
      tags: tags ?? [],
    });
  });

  app.get('/v1/tenants/:tenantId/venues', { preHandler: requireAuth }, async (req) => {
    const { tenantId } = req.params as { tenantId: string };
    const user = await currentUser(req);
    await requireTenantMembership(user.id, tenantId);
    return listVenues(tenantId);
  });

  app.get('/v1/venues/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const venue = await getVenueById(id);
    if (!venue) throw new NotFound('Venue not found', 'venue_not_found');
    const user = await currentUser(req);
    await requireTenantMembership(user.id, venue.tenantId);
    return venue;
  });

  app.patch('/v1/venues/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = updateVenueSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequest('Invalid venue patch', 'bad_request', { issues: parsed.error.issues });
    }
    const venue = await getVenueById(id);
    if (!venue) throw new NotFound('Venue not found', 'venue_not_found');
    const user = await currentUser(req);
    await requireTenantMembership(user.id, venue.tenantId);
    const p = parsed.data;
    return updateVenue(venue.tenantId, id, {
      ...(p.name !== undefined ? { name: p.name } : {}),
      ...(p.tzName !== undefined ? { tzName: p.tzName } : {}),
      ...(p.lat !== undefined ? { lat: p.lat } : {}),
      ...(p.lng !== undefined ? { lng: p.lng } : {}),
      ...(p.addressJson !== undefined ? { addressJson: p.addressJson } : {}),
      ...(p.status !== undefined ? { status: p.status } : {}),
    });
  });
};
