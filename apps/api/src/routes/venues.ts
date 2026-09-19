import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { BadRequest, NotFound } from '../lib/errors.js';
import { assertCap } from '../middleware/require_cap.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
import { assertTermsAccepted } from '../middleware/require_terms.js';
import { requireTenantMembership } from '../middleware/tenant_context.js';
import { amenitiesSchema, openingHoursSchema } from '../lib/venue_metadata.js';
import { getGeocoder } from '../lib/geocoding/index.js';
import { suggestCity } from '../lib/geocoding/gazetteer.js';
import {
  closeVenue,
  createVenue,
  getVenueById,
  listVenues,
  reopenVenue,
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

const geocodeSearchSchema = z.object({
  q: z.string().trim().min(2).max(120),
  country: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(10).optional(),
});

const suggestCitySchema = z.object({
  city: z.string().trim().min(1).max(120),
  country: z.string().trim().max(120).optional(),
});

export const venueRoutes: FastifyPluginAsync = async (app) => {
  // Address autocomplete for the venue form. Auth-gated (partner-only) so the
  // upstream geocoder isn't an open proxy; results are normalised + restricted
  // to the countries we serve inside the provider (see lib/geocoding).
  app.get('/v1/venues/geocode/search', { preHandler: requireAuth }, async (req) => {
    const parsed = geocodeSearchSchema.safeParse(req.query);
    if (!parsed.success) {
      throw new BadRequest('Invalid search query', 'bad_request', { issues: parsed.error.issues });
    }
    await currentUser(req); // any authenticated partner may search
    const { q, country, limit } = parsed.data;
    const suggestions = await getGeocoder().search(q, { country: country ?? null, limit: limit ?? 5 });
    return { suggestions };
  });

  // "Did you mean" for a hand-typed city: canonical spelling for alias/case
  // variants, or the nearest known city within a small edit distance
  // ("Banagalore" → "Bengaluru"). Purely offline (gazetteer) — no upstream
  // geocoder call. Null when the input is already canonical or unrecognised.
  app.get('/v1/venues/geocode/suggest-city', { preHandler: requireAuth }, async (req) => {
    const parsed = suggestCitySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new BadRequest('Invalid city query', 'bad_request', { issues: parsed.error.issues });
    }
    await currentUser(req); // any authenticated partner
    const { city, country } = parsed.data;
    return { suggestion: suggestCity(city, country ?? null) };
  });

  app.post('/v1/tenants/:tenantId/venues', { preHandler: requireAuth }, async (req) => {
    const { tenantId } = req.params as { tenantId: string };
    const parsed = createVenueSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequest('Invalid venue payload', 'bad_request', { issues: parsed.error.issues });
    }
    const user = await currentUser(req);
    const ctx = await requireTenantMembership(user.id, tenantId);
    assertCap(ctx, 'venues.write');
    assertTermsAccepted(ctx);
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
    const { status, ...p } = parsed.data;

    // `status` is still accepted here so existing callers keep working, but it
    // now moves only through close/reopen. It used to be written straight to
    // the row, so a partner could send `status: 'active'` and publish a venue
    // Circls had never reviewed, or overturn a rejection.
    let result = venue;
    if (status === 'suspended') {
      result = await closeVenue({ tenantId: venue.tenantId, actorUserId: user.id }, id);
    } else if (status === 'active' && venue.status !== 'active') {
      // Only a closed venue can be reopened (409 otherwise), and it comes back
      // to its prior status — which may be review rather than live. The
      // returned row carries the status it actually has.
      result = await reopenVenue({ tenantId: venue.tenantId, actorUserId: user.id }, id);
    }

    const fields = {
      ...(p.name !== undefined ? { name: p.name } : {}),
      ...(p.tzName !== undefined ? { tzName: p.tzName } : {}),
      ...(p.lat !== undefined ? { lat: p.lat } : {}),
      ...(p.lng !== undefined ? { lng: p.lng } : {}),
      ...(p.addressJson !== undefined ? { addressJson: p.addressJson } : {}),
      ...(p.tags !== undefined ? { tags: p.tags } : {}),
      ...pickMetadata(p),
    };
    return Object.keys(fields).length > 0 ? updateVenue(venue.tenantId, id, fields) : result;
  });

  // ── Close / reopen ─────────────────────────────────────────────────────────
  // Closing takes a venue off the consumer portal; reopening puts it back to
  // exactly the state it was in. See closeVenue / reopenVenue.
  app.post('/v1/venues/:id/close', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const venue = await getVenueById(id);
    if (!venue) throw new NotFound('Venue not found', 'venue_not_found');
    const user = await currentUser(req);
    const ctx = await requireTenantMembership(user.id, venue.tenantId);
    assertCap(ctx, 'venues.write');
    return closeVenue({ tenantId: venue.tenantId, actorUserId: user.id }, id);
  });

  app.post('/v1/venues/:id/reopen', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const venue = await getVenueById(id);
    if (!venue) throw new NotFound('Venue not found', 'venue_not_found');
    const user = await currentUser(req);
    const ctx = await requireTenantMembership(user.id, venue.tenantId);
    assertCap(ctx, 'venues.write');
    return reopenVenue({ tenantId: venue.tenantId, actorUserId: user.id }, id);
  });
};
