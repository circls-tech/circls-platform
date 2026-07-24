import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { BadRequest, NotFound } from '../lib/errors.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
import { assertTermsAccepted } from '../middleware/require_terms.js';
import { requireTenantMembership } from '../middleware/tenant_context.js';
import {
  cancelEvent,
  cancelEventSeries,
  createEvent,
  createEventSeries,
  getEvent,
  listEventBookings,
  listEventsForTenant,
  listEventsForVenue,
  listSeriesEvents,
  MAX_SERIES_OCCURRENCES,
  publishEvent,
  publishEventSeries,
  updateEvent,
  type CreateEventInput,
} from '../services/events_service.js';
import { getVenueById } from '../services/venue_service.js';
import type { TierInput } from '../services/event_tiers_service.js';
import {
  qrTicketConfigSchema,
  toQrTicketConfig,
  toTierQrTicketConfig,
} from '../lib/qr_ticket_config_schema.js';

const tierSchema = z.object({
  name: z.string().min(1).max(120),
  description: z
    .string()
    .max(2000)
    .optional()
    .transform((v) => v ?? null),
  pricePaise: z.number().int().min(0),
  capacity: z
    .number()
    .int()
    .min(1)
    .nullable()
    .optional()
    .transform((v) => v ?? null),
  // Per-tier QR override: omitted/null = inherit the event's config;
  // enabled:false = explicitly off for this tier; enabled:true = custom rules.
  qrTicketConfig: qrTicketConfigSchema.optional(),
});
const tiersField = z.array(tierSchema).min(1).max(20);

/** Map a parsed tier payload to the service input, normalising its QR override. */
function tierToInput(t: z.infer<typeof tierSchema>): TierInput {
  return {
    name: t.name,
    description: t.description,
    pricePaise: t.pricePaise,
    capacity: t.capacity,
    qrTicketConfig: t.qrTicketConfig !== undefined ? toTierQrTicketConfig(t.qrTicketConfig) : null,
  };
}

/**
 * One date of a recurring event. Omitted fields inherit the base payload;
 * `venueId: <uuid>` moves that date to another venue, `venueId: null` makes it
 * standalone at `addressJson`/`tzName` (falling back to the base address).
 */
const occurrenceSchema = z.object({
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  venueId: z.string().uuid().nullable().optional(),
  addressJson: z.record(z.unknown()).optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  tzName: z.string().min(1).optional(),
  tiers: tiersField.optional(),
});
const occurrencesField = z.array(occurrenceSchema).min(2).max(MAX_SERIES_OCCURRENCES);

// Per-customer ticket cap for the whole event (all tiers); null = no limit.
const maxPerUserField = z.number().int().min(1).nullable().optional();

// Consumer discovery: public (default) / unlisted (direct link only) /
// access_code (listed, but entry gated behind `accessCode`).
const visibilityField = z.enum(['public', 'unlisted', 'access_code']).optional();
const accessCodeField = z.string().trim().min(4).max(64).nullable().optional();

/** access_code events must carry a code in the same payload. */
function visibilityNeedsCode(d: { visibility?: string | undefined; accessCode?: string | null | undefined }) {
  return d.visibility !== 'access_code' || Boolean(d.accessCode);
}
const NEEDS_CODE_MSG = 'Invite-only (access code) events require accessCode';

const createEventSchema = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().optional(),
    startsAt: z.string().datetime().optional(),
    endsAt: z.string().datetime().optional(),
    tiers: tiersField,
    maxPerUser: maxPerUserField,
    qrTicketConfig: qrTicketConfigSchema.optional(),
    visibility: visibilityField,
    accessCode: accessCodeField,
    /** ≥2 dates makes this a recurring series; omit for a one-off event. */
    occurrences: occurrencesField.optional(),
  })
  .refine((d) => d.occurrences !== undefined || (d.startsAt && d.endsAt), {
    message: 'Provide startsAt/endsAt, or occurrences for a recurring event',
  })
  .refine(visibilityNeedsCode, { message: NEEDS_CODE_MSG });

const createTenantEventSchema = z
  .object({
    venueId: z.string().uuid().optional(),
    addressJson: z.record(z.unknown()).optional(),
    lat: z.number().optional(),
    lng: z.number().optional(),
    tzName: z.string().min(1).optional(),
    name: z.string().min(1).max(200),
    description: z.string().optional(),
    startsAt: z.string().datetime().optional(),
    endsAt: z.string().datetime().optional(),
    tiers: tiersField,
    maxPerUser: maxPerUserField,
    qrTicketConfig: qrTicketConfigSchema.optional(),
    visibility: visibilityField,
    accessCode: accessCodeField,
    /** ≥2 dates makes this a recurring series; omit for a one-off event. */
    occurrences: occurrencesField.optional(),
  })
  .refine((d) => d.occurrences !== undefined || (d.startsAt && d.endsAt), {
    message: 'Provide startsAt/endsAt, or occurrences for a recurring event',
  })
  .refine(visibilityNeedsCode, { message: NEEDS_CODE_MSG })
  // Exactly one scope: a venue OR a standalone address (never both, never neither).
  .refine((d) => Boolean(d.venueId) !== Boolean(d.addressJson), {
    message: 'Provide exactly one of venueId or addressJson',
  })
  .refine((d) => Boolean(d.venueId) || Boolean(d.tzName), {
    message: 'Standalone events require tzName',
  })
  // A standalone scope must carry a real address, not just `{}`.
  .refine(
    (d) => Boolean(d.venueId) || (d.addressJson != null && Object.keys(d.addressJson).length > 0),
    { message: 'Standalone events require a non-empty address' },
  );

const updateEventSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().nullable().optional(),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().optional(),
  // Re-scope the event: a venue id makes it venue-scoped; null makes it
  // standalone. When going standalone, the address/tz below are used (falling
  // back to any address the event already carries). Absent venueId = no change.
  venueId: z.string().uuid().nullable().optional(),
  addressJson: z.record(z.unknown()).optional(),
  lat: z.number().nullable().optional(),
  lng: z.number().nullable().optional(),
  tzName: z.string().min(1).optional(),
  tiers: tiersField.optional(),
  maxPerUser: maxPerUserField,
  qrTicketConfig: qrTicketConfigSchema.optional(),
  // Visibility/access code are editable on drafts AND live events (the service
  // validates that access_code events always end up with a code).
  visibility: visibilityField,
  accessCode: accessCodeField,
  // Published-only: raise individual tiers' capacity by id (null = unlimited).
  // The service rejects decreases and any use on drafts.
  tierCapacities: z
    .array(
      z.object({
        tierId: z.string().uuid(),
        capacity: z.number().int().min(1).nullable(),
      }),
    )
    .max(20)
    .optional(),
});

type OccurrenceInput = z.infer<typeof occurrenceSchema>;

/**
 * Resolve base payload + per-date overrides into one CreateEventInput per date.
 * Any override venue must belong to the tenant (checked once per distinct id).
 */
async function resolveOccurrences(
  tenantId: string,
  base: Omit<CreateEventInput, 'startsAt' | 'endsAt'>,
  occurrences: OccurrenceInput[],
): Promise<CreateEventInput[]> {
  const overrideVenueIds = new Set<string>();
  for (const occ of occurrences) if (occ.venueId) overrideVenueIds.add(occ.venueId);
  for (const vid of overrideVenueIds) {
    const venue = await getVenueById(vid);
    if (!venue || venue.tenantId !== tenantId)
      throw new NotFound('Venue not found', 'venue_not_found');
  }
  return occurrences.map((occ) => {
    // undefined = inherit the base scope; uuid = that venue; null = standalone.
    const venueId = occ.venueId === undefined ? base.venueId : (occ.venueId ?? undefined);
    const standalone = !venueId;
    return {
      ...base,
      venueId,
      addressJson: standalone ? (occ.addressJson ?? base.addressJson) : undefined,
      lat: standalone ? (occ.lat ?? base.lat) : undefined,
      lng: standalone ? (occ.lng ?? base.lng) : undefined,
      tzName: standalone ? (occ.tzName ?? base.tzName) : undefined,
      startsAt: new Date(occ.startsAt),
      endsAt: new Date(occ.endsAt),
      tiers: occ.tiers ? occ.tiers.map(tierToInput) : base.tiers,
    };
  });
}

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
    const memberCtx = await requireTenantMembership(user.id, venue.tenantId);
    assertTermsAccepted(memberCtx);
    const parsed = createEventSchema.safeParse(req.body);
    if (!parsed.success)
      throw new BadRequest('Invalid event payload', 'bad_request', {
        issues: parsed.error.issues,
      });
    const ctx = { tenantId: venue.tenantId, actorUserId: user.id };
    const base = {
      tenantId: venue.tenantId,
      venueId,
      name: parsed.data.name,
      description: parsed.data.description,
      tiers: parsed.data.tiers.map(tierToInput),
      maxPerUser: parsed.data.maxPerUser ?? null,
      visibility: parsed.data.visibility,
      accessCode: parsed.data.accessCode,
      ...(parsed.data.qrTicketConfig !== undefined
        ? { qrTicketConfig: toQrTicketConfig(parsed.data.qrTicketConfig) }
        : {}),
    };
    if (parsed.data.occurrences) {
      const occs = await resolveOccurrences(venue.tenantId, base, parsed.data.occurrences);
      const rows = await createEventSeries(ctx, occs);
      return { seriesId: rows[0]!.seriesId, count: rows.length, events: rows };
    }
    return createEvent(ctx, {
      ...base,
      startsAt: new Date(parsed.data.startsAt!),
      endsAt: new Date(parsed.data.endsAt!),
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

  app.get('/v1/tenants/:tenantId/events', { preHandler: requireAuth }, async (req) => {
    const { tenantId } = req.params as { tenantId: string };
    const user = await currentUser(req);
    await requireTenantMembership(user.id, tenantId);
    return listEventsForTenant(tenantId);
  });

  app.post('/v1/tenants/:tenantId/events', { preHandler: requireAuth }, async (req) => {
    const { tenantId } = req.params as { tenantId: string };
    const user = await currentUser(req);
    const memberCtx = await requireTenantMembership(user.id, tenantId);
    assertTermsAccepted(memberCtx);
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

    const ctx = { tenantId, actorUserId: user.id };
    const base = {
      tenantId,
      venueId: parsed.data.venueId,
      addressJson: parsed.data.addressJson,
      lat: parsed.data.lat,
      lng: parsed.data.lng,
      tzName: parsed.data.tzName,
      name: parsed.data.name,
      description: parsed.data.description,
      tiers: parsed.data.tiers.map(tierToInput),
      maxPerUser: parsed.data.maxPerUser ?? null,
      visibility: parsed.data.visibility,
      accessCode: parsed.data.accessCode,
      ...(parsed.data.qrTicketConfig !== undefined
        ? { qrTicketConfig: toQrTicketConfig(parsed.data.qrTicketConfig) }
        : {}),
    };
    if (parsed.data.occurrences) {
      const occs = await resolveOccurrences(tenantId, base, parsed.data.occurrences);
      const rows = await createEventSeries(ctx, occs);
      return { seriesId: rows[0]!.seriesId, count: rows.length, events: rows };
    }
    return createEvent(ctx, {
      ...base,
      startsAt: new Date(parsed.data.startsAt!),
      endsAt: new Date(parsed.data.endsAt!),
    });
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
    if (parsed.data.tiers !== undefined) patch.tiers = parsed.data.tiers.map(tierToInput);
    if (parsed.data.maxPerUser !== undefined) patch.maxPerUser = parsed.data.maxPerUser;
    if (parsed.data.visibility !== undefined) patch.visibility = parsed.data.visibility;
    if (parsed.data.accessCode !== undefined) patch.accessCode = parsed.data.accessCode;
    if (parsed.data.tierCapacities !== undefined) patch.tierCapacities = parsed.data.tierCapacities;
    if (parsed.data.qrTicketConfig !== undefined)
      patch.qrTicketConfig = toQrTicketConfig(parsed.data.qrTicketConfig);
    if (parsed.data.venueId !== undefined) {
      // Re-scoping to a venue: the venue must belong to this tenant.
      if (parsed.data.venueId) {
        const venue = await getVenueById(parsed.data.venueId);
        if (!venue || venue.tenantId !== tenantId)
          throw new NotFound('Venue not found', 'venue_not_found');
      }
      patch.venueId = parsed.data.venueId;
    }
    // Standalone address/location — used when going (or staying) standalone.
    if (parsed.data.addressJson !== undefined) patch.addressJson = parsed.data.addressJson;
    if (parsed.data.tzName !== undefined) patch.tzName = parsed.data.tzName;
    if (parsed.data.lat !== undefined) patch.lat = parsed.data.lat;
    if (parsed.data.lng !== undefined) patch.lng = parsed.data.lng;
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

  // Series (recurring event) reads + bulk lifecycle actions.
  app.get(
    '/v1/tenants/:tenantId/event-series/:seriesId',
    { preHandler: requireAuth },
    async (req) => {
      const { tenantId, seriesId } = req.params as { tenantId: string; seriesId: string };
      const user = await currentUser(req);
      await requireTenantMembership(user.id, tenantId);
      const rows = await listSeriesEvents(tenantId, seriesId);
      if (rows.length === 0) throw new NotFound('Series not found', 'series_not_found');
      return { seriesId, events: rows };
    },
  );

  app.post(
    '/v1/tenants/:tenantId/event-series/:seriesId/publish',
    { preHandler: requireAuth },
    async (req) => {
      const { tenantId, seriesId } = req.params as { tenantId: string; seriesId: string };
      const user = await currentUser(req);
      await requireTenantMembership(user.id, tenantId);
      const rows = await publishEventSeries({ tenantId, actorUserId: user.id }, seriesId);
      return { seriesId, count: rows.length, events: rows };
    },
  );

  app.post(
    '/v1/tenants/:tenantId/event-series/:seriesId/cancel',
    { preHandler: requireAuth },
    async (req) => {
      const { tenantId, seriesId } = req.params as { tenantId: string; seriesId: string };
      const user = await currentUser(req);
      await requireTenantMembership(user.id, tenantId);
      const rows = await cancelEventSeries({ tenantId, actorUserId: user.id }, seriesId);
      return { seriesId, count: rows.length, events: rows };
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
