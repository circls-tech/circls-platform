import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { env } from '../config/env.js';
import { BadRequest, NotFound } from '../lib/errors.js';
import { checkoutGatewaysOf } from '../lib/gateway.js';
import { getGeocoder } from '../lib/geocoding/index.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
import {
  MAX_LINES_PER_EVENT_BOOKING,
  MAX_SLOTS_PER_BOOKING,
  MAX_TICKETS_PER_LINE,
} from '../lib/booking_limits.js';
import { perIdentityRateLimit } from '../lib/rate_limit.js';
import { registrationAnswersField } from '../lib/registration_answers_schema.js';
import {
  consumerBookEvent,
  consumerBookSlots,
  consumerPurchaseMembership,
  deleteMyAccount,
  getMyBookingDetail,
  getMyProfile,
  getPublicEventById,
  getPublicMembershipById,
  getPublicOrgBySlug,
  getPublicVenueWithImages,
  listMyBookings,
  listPublicOrgs,
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
import {
  addToWishlist,
  getWishlist,
  listWishlistIds,
  removeFromWishlist,
  WISHLIST_ITEM_TYPES,
} from '../services/wishlist_service.js';

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

/** Reverse-geocode query — coords the consumer shared from the browser. */
export const reverseGeocodeQuery = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
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

  // Second ceiling for signed-in callers, keyed on the VERIFIED uid (so it
  // sits after requireAuth): the global limiter is per IP, which a caller
  // rotating addresses can spread across.
  const perUserLimit = perIdentityRateLimit(app);

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

  // Coords → coarse place (city/country), so the app can label the location
  // pin with the user's actual city when they're outside every served city.
  // Public (anonymous browse shares the pin) but under the strict public rate
  // ceiling; the response never carries more precision than a city name.
  app.get('/v1/consumer/geocode/reverse', { config: publicLimit }, async (req) => {
    const parsed = reverseGeocodeQuery.safeParse(req.query);
    if (!parsed.success) throw new BadRequest('Invalid query', 'bad_request', { issues: parsed.error.issues });
    const place = await getGeocoder().reverse(parsed.data);
    return { place };
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

  app.get('/v1/consumer/memberships/:membershipId', { config: publicLimit }, async (req) => {
    const { membershipId } = req.params as { membershipId: string };
    const m = await getPublicMembershipById(membershipId);
    if (!m) throw new NotFound('Membership not found', 'membership_not_found');
    return m;
  });

  // Public organisers directory — active, non-platform orgs only, A→Z.
  app.get('/v1/consumer/orgs', { config: publicLimit }, async () => {
    const rows = await listPublicOrgs();
    return { rows };
  });

  // Public org/brand profile (PR #108). Only active orgs are returned; inactive
  // or missing → 404. Never carries private/billing fields.
  app.get('/v1/consumer/orgs/:slug', { config: publicLimit }, async (req) => {
    const { slug } = req.params as { slug: string };
    const org = await getPublicOrgBySlug(slug);
    if (!org) throw new NotFound('Organisation not found', 'org_not_found');
    return org;
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
    slotIds: z.array(z.string().uuid()).min(1).max(MAX_SLOTS_PER_BOOKING),
    customerName: z.string().min(1).max(200),
    customerContact: z.string().min(1).max(200),
    note: z.string().max(500).optional(),
    couponCode: z.string().min(1).max(64).optional(),
  });
  app.post('/v1/consumer/bookings', { preHandler: [requireAuth, perUserLimit], config: publicLimit }, async (req) => {
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
      checkoutGateways: checkoutGatewaysOf(req.headers),
    });
  });

  const bookEventBody = z.object({
    name: z.string().max(200).optional(),
    contact: z.string().max(200).optional(),
    couponCode: z.string().min(1).max(64).optional(),
    lines: z
      .array(
        z.object({
          tierId: z.string().uuid(),
          quantity: z.number().int().min(1).max(MAX_TICKETS_PER_LINE),
        }),
      )
      .min(1)
      .max(MAX_LINES_PER_EVENT_BOOKING),
    // Answers to the event's registration questions (validated in the service
    // against the live question set — required questions must be answered).
    answers: registrationAnswersField
      .optional(),
  });
  app.post('/v1/consumer/events/:eventId/book', { preHandler: [requireAuth, perUserLimit], config: publicLimit }, async (req) => {
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
        checkoutGateways: checkoutGatewaysOf(req.headers),
      },
      parsed.data.lines,
      parsed.data.couponCode,
      parsed.data.answers ?? [],
    );
  });

  const purchaseMembershipBody = z.object({
    couponCode: z.string().min(1).max(64).optional(),
    membershipTierId: z.string().uuid().optional(),
  });
  app.post('/v1/consumer/memberships/:membershipId/purchase', { preHandler: [requireAuth, perUserLimit], config: publicLimit }, async (req) => {
    const { membershipId } = req.params as { membershipId: string };
    const user = await currentUser(req);
    const parsed = purchaseMembershipBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequest('Invalid payload', 'bad_request', { issues: parsed.error.issues });
    return consumerPurchaseMembership(
      membershipId,
      user.id,
      parsed.data.couponCode,
      parsed.data.membershipTierId,
      checkoutGatewaysOf(req.headers),
    );
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

  /**
   * Self-service account deletion (A7) — the in-app half of the Google Play /
   * App Store requirement; https://circls.app/account/delete is the web half.
   *
   * Anonymises the users row and clears the personal trail, then deletes the
   * Firebase account. Bookings and payments are retained (financial records).
   *
   * Keyed off the token's uid rather than `currentUser`, which would create a
   * row on first sight — this handler must never mint a user just to delete it.
   * That also makes a RETRY after a failed Firebase teardown a clean 204: the
   * token still verifies (nothing was revoked), no live row is found, and only
   * the Firebase side is redone. Note that once teardown has SUCCEEDED the
   * Firebase account is gone, so a replayed token is rejected by `requireAuth`
   * with 401 — not 204. Returns 409 `partner_account` if the caller also has
   * partner-portal access.
   */
  app.delete('/v1/consumer/me', { preHandler: requireAuth }, async (req, reply) => {
    // requireAuth guarantees authUser is set, or it would have thrown.
    await deleteMyAccount(req.authUser!.firebaseUid);
    return reply.status(204).send();
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

  // ── Wishlist / likes (authenticated consumer) ─────────────────────────────
  // The heart on event, membership and venue cards. Private to the signed-in
  // consumer; a like is only accepted for a listing the public catalogue shows
  // right now, and the hydrated read re-applies that gate.

  /** The wishlist in card shape, each section most-recently-liked first. */
  app.get('/v1/consumer/me/wishlist', { preHandler: requireAuth }, async (req) => {
    const user = await currentUser(req);
    return getWishlist(user.id);
  });

  /** Just the liked ids per type — enough to paint hearts on any listing. */
  app.get('/v1/consumer/me/wishlist/ids', { preHandler: requireAuth }, async (req) => {
    const user = await currentUser(req);
    return listWishlistIds(user.id);
  });

  const wishlistParams = z.object({
    itemType: z.enum(WISHLIST_ITEM_TYPES),
    itemId: z.string().uuid(),
  });
  const parseWishlistParams = (params: unknown) => {
    const parsed = wishlistParams.safeParse(params);
    if (!parsed.success) throw new BadRequest('Invalid wishlist item', 'bad_request', { issues: parsed.error.issues });
    return parsed.data;
  };

  /** Like. Idempotent; 404 when the listing is missing or not public. */
  app.put(
    '/v1/consumer/me/wishlist/:itemType/:itemId',
    { preHandler: [requireAuth, perUserLimit] },
    async (req) => {
      const { itemType, itemId } = parseWishlistParams(req.params);
      const user = await currentUser(req);
      await addToWishlist(user.id, itemType, itemId);
      return { liked: true };
    },
  );

  /** Unlike. Idempotent. */
  app.delete(
    '/v1/consumer/me/wishlist/:itemType/:itemId',
    { preHandler: [requireAuth, perUserLimit] },
    async (req) => {
      const { itemType, itemId } = parseWishlistParams(req.params);
      const user = await currentUser(req);
      await removeFromWishlist(user.id, itemType, itemId);
      return { liked: false };
    },
  );

  app.get('/v1/consumer/me/bookings/:id', { preHandler: requireAuth }, async (req) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) throw new NotFound('Booking not found', 'booking_not_found');
    const user = await currentUser(req);
    return { booking: await getMyBookingDetail(user.id, params.data.id) };
  });
};
