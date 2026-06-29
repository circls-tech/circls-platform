import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { BadRequest, NotFound } from '../lib/errors.js';
import { assertCap } from '../middleware/require_cap.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
import { requireTenantMembership } from '../middleware/tenant_context.js';
import { amenitiesSchema, openingHoursSchema } from '../lib/venue_metadata.js';
import {
  createVenue,
  getVenueById,
  listVenues,
  updateVenue,
  type VenueMetadataInput,
} from '../services/venue_service.js';

// Empty strings from form inputs collapse to null so we never persist "".
const nullableTrimmed = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((s) => (s.length === 0 ? null : s))
    .nullable()
    .optional();

// Trust-metadata fields (PR #109) shared by create + update.
const venueMetadataShape = {
  description: nullableTrimmed(2000),
  amenities: amenitiesSchema.optional(),
  openingHours: openingHoursSchema.nullable().optional(),
  contactPhone: nullableTrimmed(40),
  contactEmail: z
    .union([z.string().trim().email().max(200), z.literal('')])
    .transform((s) => (s === '' ? null : s))
    .nullable()
    .optional(),
  addressLine1: nullableTrimmed(200),
  addressLine2: nullableTrimmed(200),
  city: nullableTrimmed(120),
  state: nullableTrimmed(120),
  postalCode: nullableTrimmed(20),
  country: nullableTrimmed(120),
};

const createVenueSchema = z.object({
  name: z.string().min(1).max(200),
  tzName: z.string().min(1).max(64).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  addressJson: z.record(z.unknown()).optional(),
  tags: z.array(z.string().min(1).max(40)).max(20).optional(),
  ...venueMetadataShape,
});
const updateVenueSchema = createVenueSchema.partial().extend({
  status: z.enum(['active', 'suspended']).optional(),
});

/** Pull the (already-validated) trust-metadata keys present on a parsed body. */
function pickMetadata(p: z.infer<typeof updateVenueSchema>): VenueMetadataInput {
  return {
    ...(p.description !== undefined && { description: p.description }),
    ...(p.amenities !== undefined && { amenities: p.amenities }),
    ...(p.openingHours !== undefined && { openingHours: p.openingHours }),
    ...(p.contactPhone !== undefined && { contactPhone: p.contactPhone }),
    ...(p.contactEmail !== undefined && { contactEmail: p.contactEmail }),
    ...(p.addressLine1 !== undefined && { addressLine1: p.addressLine1 }),
    ...(p.addressLine2 !== undefined && { addressLine2: p.addressLine2 }),
    ...(p.city !== undefined && { city: p.city }),
    ...(p.state !== undefined && { state: p.state }),
    ...(p.postalCode !== undefined && { postalCode: p.postalCode }),
    ...(p.country !== undefined && { country: p.country }),
  };
}

export const venueRoutes: FastifyPluginAsync = async (app) => {
  app.post('/v1/tenants/:tenantId/venues', { preHandler: requireAuth }, async (req) => {
    const { tenantId } = req.params as { tenantId: string };
    const parsed = createVenueSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequest('Invalid venue payload', 'bad_request', { issues: parsed.error.issues });
    }
    const user = await currentUser(req);
    const ctx = await requireTenantMembership(user.id, tenantId);
    assertCap(ctx, 'venues.write');
    const { name, tzName, lat, lng, addressJson, tags } = parsed.data;
    return createVenue(tenantId, {
      name,
      tzName: tzName ?? 'Asia/Kolkata',
      lat: lat ?? null,
      lng: lng ?? null,
      addressJson: addressJson ?? null,
      tags: tags ?? [],
      ...pickMetadata(parsed.data),
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
    const ctx = await requireTenantMembership(user.id, venue.tenantId);
    assertCap(ctx, 'venues.write');
    const p = parsed.data;
    return updateVenue(venue.tenantId, id, {
      ...(p.name !== undefined ? { name: p.name } : {}),
      ...(p.tzName !== undefined ? { tzName: p.tzName } : {}),
      ...(p.lat !== undefined ? { lat: p.lat } : {}),
      ...(p.lng !== undefined ? { lng: p.lng } : {}),
      ...(p.addressJson !== undefined ? { addressJson: p.addressJson } : {}),
      ...(p.tags !== undefined ? { tags: p.tags } : {}),
      ...(p.status !== undefined ? { status: p.status } : {}),
      ...pickMetadata(p),
    });
  });
};
