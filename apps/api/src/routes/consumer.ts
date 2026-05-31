import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { BadRequest, NotFound } from '../lib/errors.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
import {
  consumerBookEvent,
  consumerBookSlots,
  consumerPurchaseMembership,
  getMyProfile,
  getPublicEventById,
  getPublicVenue,
  listMyBookings,
  listPublicArenas,
  listPublicArenaSlots,
  listPublicEvents,
  listPublicMemberships,
  listPublicMembershipsAcrossVenues,
  listPublicUpcomingEvents,
  listPublicVenues,
  updateMyProfile,
} from '../services/consumer_service.js';

/**
 * Consumer portal API (subproject E) for circls.app. Browse endpoints are
 * UNAUTHENTICATED (anonymous discovery); booking/purchase/history require a
 * Firebase-authenticated consumer (any sign-in method — no tenant membership).
 * Every read is approval + tenant-active filtered inside consumer_service.
 */
export const consumerRoutes: FastifyPluginAsync = async (app) => {
  // ── Browse (public) ────────────────────────────────────────────────────────
  const venuesQuery = z.object({
    search: z.string().min(1).max(120).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  });
  app.get('/v1/consumer/venues', async (req) => {
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

  app.get('/v1/consumer/events', async (req) => {
    const parsed = limitQuery.safeParse(req.query);
    if (!parsed.success) throw new BadRequest('Invalid query', 'bad_request', { issues: parsed.error.issues });
    const rows = await listPublicUpcomingEvents({ ...(parsed.data.limit ? { limit: parsed.data.limit } : {}) });
    return { rows };
  });

  app.get('/v1/consumer/events/:id', async (req) => {
    const { id } = req.params as { id: string };
    const ev = await getPublicEventById(id);
    if (!ev) throw new NotFound('Event not found', 'event_not_found');
    return ev;
  });

  app.get('/v1/consumer/memberships', async (req) => {
    const parsed = limitQuery.safeParse(req.query);
    if (!parsed.success) throw new BadRequest('Invalid query', 'bad_request', { issues: parsed.error.issues });
    const rows = await listPublicMembershipsAcrossVenues({ ...(parsed.data.limit ? { limit: parsed.data.limit } : {}) });
    return { rows };
  });

  app.get('/v1/consumer/venues/:venueId', async (req) => {
    const { venueId } = req.params as { venueId: string };
    const venue = await getPublicVenue(venueId);
    if (!venue) throw new NotFound('Venue not found', 'venue_not_found');
    const arenas = await listPublicArenas(venueId);
    return { venue, arenas };
  });

  app.get('/v1/consumer/venues/:venueId/events', async (req) => {
    const { venueId } = req.params as { venueId: string };
    return { rows: await listPublicEvents(venueId) };
  });

  app.get('/v1/consumer/venues/:venueId/memberships', async (req) => {
    const { venueId } = req.params as { venueId: string };
    return { rows: await listPublicMemberships(venueId) };
  });

  const slotsQuery = z.object({
    from: z.string().datetime(),
    to: z.string().datetime(),
  });
  app.get('/v1/consumer/arenas/:arenaId/slots', async (req) => {
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
  });
  app.post('/v1/consumer/bookings', { preHandler: requireAuth }, async (req) => {
    const user = await currentUser(req);
    const parsed = bookSlotsBody.safeParse(req.body);
    if (!parsed.success) throw new BadRequest('Invalid booking payload', 'bad_request', { issues: parsed.error.issues });
    return consumerBookSlots({
      slotIds: parsed.data.slotIds,
      customerName: parsed.data.customerName,
      customerContact: parsed.data.customerContact,
      note: parsed.data.note ?? null,
      actorUserId: user.id,
    });
  });

  const bookEventBody = z.object({
    name: z.string().max(200).optional(),
    contact: z.string().max(200).optional(),
  });
  app.post('/v1/consumer/events/:eventId/book', { preHandler: requireAuth }, async (req) => {
    const { eventId } = req.params as { eventId: string };
    const user = await currentUser(req);
    const parsed = bookEventBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequest('Invalid payload', 'bad_request', { issues: parsed.error.issues });
    return consumerBookEvent(eventId, {
      userId: user.id,
      name: parsed.data.name ?? null,
      contact: parsed.data.contact ?? null,
    });
  });

  app.post('/v1/consumer/memberships/:membershipId/purchase', { preHandler: requireAuth }, async (req) => {
    const { membershipId } = req.params as { membershipId: string };
    const user = await currentUser(req);
    return consumerPurchaseMembership(membershipId, user.id);
  });

  app.get('/v1/consumer/me/bookings', { preHandler: requireAuth }, async (req) => {
    const user = await currentUser(req);
    return { rows: await listMyBookings(user.id) };
  });
};
