import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { env } from '../config/env.js';
import { BadRequest, NotFound } from '../lib/errors.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
import {
  consumerBookEvent,
  consumerBookSlots,
  consumerPurchaseMembership,
  getMyBookingDetail,
  getMyProfile,
  getPublicEventById,
  getPublicVenueWithImages,
  listMyBookings,
  listPublicArenas,
  listPublicArenaSlots,
  listPublicEvents,
  listPublicMemberships,
  listPublicMembershipsAcrossVenues,
  listPublicUpcomingEvents,
  listPublicVenues,
  logConsumerActivity,
  updateMyProfile,
} from '../services/consumer_service.js';

/** Behavioral telemetry batch (M6). event_type/item_type kept open (telemetry,
 *  not domain) so new client signals never need a server change. */
export const activityEventInput = z.object({
  eventType: z.string().min(1).max(64),
  itemType: z.string().max(40).optional(),
  itemId: z.string().max(200).optional(),
  props: z.record(z.unknown()).optional(),
  clientTs: z.string().datetime(),
  sessionId: z.string().max(200).optional(),
});
export const activityBatchBody = z.object({
  events: z.array(activityEventInput).min(1).max(200),
});

/**
 * Consumer portal API (subproject E) for circls.app. Browse endpoints are
 * UNAUTHENTICATED (anonymous discovery); booking/purchase/history require a
 * Firebase-authenticated consumer (any sign-in method — no tenant membership).
 * Every read is approval + tenant-active filtered inside consumer_service.
 */
export const consumerRoutes: FastifyPluginAsync = async (app) => {
  // Stricter public ceiling (M6 rate limiting) for anonymous browse +
  // consumer book/purchase. Inherits the global allowList (test-disabled).
  const publicLimit = {
    rateLimit: { max: env.RATE_LIMIT_PUBLIC_MAX, timeWindow: '1 minute' },
  } as const;

  // ── Browse (public) ────────────────────────────────────────────────────────
  const venuesQuery = z.object({
    search: z.string().min(1).max(120).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  });
  app.get('/v1/consumer/venues', { config: publicLimit }, async (req) => {
    const parsed = venuesQuery.safeParse(req.query);
    if (!parsed.success) throw new BadRequest('Invalid query', 'bad_request', { issues: parsed.error.issues });
    const rows = await listPublicVenues({
      ...(parsed.data.search ? { search: parsed.data.search } : {}),
      ...(parsed.data.limit ? { limit: parsed.data.limit } : {}),
    });
    return { rows };
  });

  // Cross-venue browse: all upcoming events / all memberships (landing rows + /events).
  const limitQuery = z.object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
  });

  app.get('/v1/consumer/events', { config: publicLimit }, async (req) => {
    const parsed = limitQuery.safeParse(req.query);
    if (!parsed.success) throw new BadRequest('Invalid query', 'bad_request', { issues: parsed.error.issues });
    const rows = await listPublicUpcomingEvents({ ...(parsed.data.limit ? { limit: parsed.data.limit } : {}) });
    return { rows };
  });

  app.get('/v1/consumer/events/:id', { config: publicLimit }, async (req) => {
    const { id } = req.params as { id: string };
    const ev = await getPublicEventById(id);
    if (!ev) throw new NotFound('Event not found', 'event_not_found');
    return ev;
  });

  app.get('/v1/consumer/memberships', { config: publicLimit }, async (req) => {
    const parsed = limitQuery.safeParse(req.query);
    if (!parsed.success) throw new BadRequest('Invalid query', 'bad_request', { issues: parsed.error.issues });
    const rows = await listPublicMembershipsAcrossVenues({ ...(parsed.data.limit ? { limit: parsed.data.limit } : {}) });
    return { rows };
  });

  app.get('/v1/consumer/venues/:venueId', { config: publicLimit }, async (req) => {
    const { venueId } = req.params as { venueId: string };
    const venue = await getPublicVenueWithImages(venueId);
    if (!venue) throw new NotFound('Venue not found', 'venue_not_found');
    const arenas = await listPublicArenas(venueId);
    return { venue, arenas };
  });

  app.get('/v1/consumer/venues/:venueId/events', { config: publicLimit }, async (req) => {
    const { venueId } = req.params as { venueId: string };
    return { rows: await listPublicEvents(venueId) };
  });

  app.get('/v1/consumer/venues/:venueId/memberships', { config: publicLimit }, async (req) => {
    const { venueId } = req.params as { venueId: string };
    return { rows: await listPublicMemberships(venueId) };
  });

  const slotsQuery = z.object({
    from: z.string().datetime(),
    to: z.string().datetime(),
  });
  app.get('/v1/consumer/arenas/:arenaId/slots', { config: publicLimit }, async (req) => {
    const { arenaId } = req.params as { arenaId: string };
    const parsed = slotsQuery.safeParse(req.query);
    if (!parsed.success) throw new BadRequest('Invalid query', 'bad_request', { issues: parsed.error.issues });
    return { rows: await listPublicArenaSlots(arenaId, parsed.data.from, parsed.data.to) };
  });

  // ── Book / purchase (authenticated consumer) ───────────────────────────────
  const bookSlotsBody = z.object({
    slotIds: z.array(z.string().uuid()).min(1),
    customerName: z.string().min(1).max(200),
    customerContact: z.string().min(1).max(200),
    note: z.string().max(500).optional(),
    couponCode: z.string().min(1).max(64).optional(),
  });
  app.post('/v1/consumer/bookings', { preHandler: requireAuth, config: publicLimit }, async (req) => {
    const user = await currentUser(req);
    const parsed = bookSlotsBody.safeParse(req.body);
    if (!parsed.success) throw new BadRequest('Invalid booking payload', 'bad_request', { issues: parsed.error.issues });
    return consumerBookSlots({
      slotIds: parsed.data.slotIds,
      customerName: parsed.data.customerName,
      customerContact: parsed.data.customerContact,
      note: parsed.data.note ?? null,
      actorUserId: user.id,
      ...(parsed.data.couponCode ? { couponCode: parsed.data.couponCode } : {}),
    });
  });

  const bookEventBody = z.object({
    name: z.string().max(200).optional(),
    contact: z.string().max(200).optional(),
    couponCode: z.string().min(1).max(64).optional(),
  });
  app.post('/v1/consumer/events/:eventId/book', { preHandler: requireAuth, config: publicLimit }, async (req) => {
    const { eventId } = req.params as { eventId: string };
    const user = await currentUser(req);
    const parsed = bookEventBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequest('Invalid payload', 'bad_request', { issues: parsed.error.issues });
    return consumerBookEvent(
      eventId,
      {
        userId: user.id,
        name: parsed.data.name ?? null,
        contact: parsed.data.contact ?? null,
      },
      parsed.data.couponCode,
    );
  });

  const purchaseMembershipBody = z.object({
    couponCode: z.string().min(1).max(64).optional(),
  });
  app.post('/v1/consumer/memberships/:membershipId/purchase', { preHandler: requireAuth, config: publicLimit }, async (req) => {
    const { membershipId } = req.params as { membershipId: string };
    const user = await currentUser(req);
    const parsed = purchaseMembershipBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequest('Invalid payload', 'bad_request', { issues: parsed.error.issues });
    return consumerPurchaseMembership(membershipId, user.id, parsed.data.couponCode);
  });

  app.get('/v1/consumer/me', { preHandler: requireAuth }, async (req) => {
    const user = await currentUser(req);
    return { profile: await getMyProfile(user.id) };
  });

  const updateProfileBody = z.object({
    displayName: z.string().min(1).max(120).optional(),
    email: z.string().email().optional(),
    interests: z.array(z.string()).optional(),
  });
  app.patch('/v1/consumer/me', { preHandler: requireAuth }, async (req) => {
    const user = await currentUser(req);
    const parsed = updateProfileBody.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequest('Invalid profile payload', 'bad_request', { issues: parsed.error.issues });
    }
    // Only forward keys that were actually provided — satisfies the service's
    // exactOptional UpdateMyProfileInput (no `undefined`-valued properties).
    const input = {
      ...(parsed.data.displayName !== undefined && { displayName: parsed.data.displayName }),
      ...(parsed.data.email !== undefined && { email: parsed.data.email }),
      ...(parsed.data.interests !== undefined && { interests: parsed.data.interests }),
    };
    return { profile: await updateMyProfile(user.id, input) };
  });

  app.get('/v1/consumer/me/bookings', { preHandler: requireAuth }, async (req) => {
    const user = await currentUser(req);
    return { rows: await listMyBookings(user.id) };
  });

  // Behavioral telemetry ingest (M6). Best-effort: a malformed batch is a 400,
  // but a bad individual item_id degrades to null inside the service rather
  // than failing the row. user_id is stamped from the token (no spoofing).
  app.post('/v1/consumer/activity', { preHandler: requireAuth }, async (req) => {
    const user = await currentUser(req);
    const parsed = activityBatchBody.safeParse(req.body);
    if (!parsed.success)
      throw new BadRequest('Invalid activity payload', 'bad_request', { issues: parsed.error.issues });
    const accepted = await logConsumerActivity(user.id, parsed.data.events);
    return { accepted };
  });

  app.get('/v1/consumer/me/bookings/:id', { preHandler: requireAuth }, async (req) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) throw new NotFound('Booking not found', 'booking_not_found');
    const user = await currentUser(req);
    return { booking: await getMyBookingDetail(user.id, params.data.id) };
  });
};
