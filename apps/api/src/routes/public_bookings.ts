/**
 * Public API surface (`/api/v1/...`) — same business logic as the internal
 * Firebase-auth routes, but gated by an API key (`Authorization: Bearer ck_…`)
 * and with `channel='aggregator'` stamped on every booking instead of `walkin`.
 *
 * Crucial property: we deliberately reuse the existing service functions so the
 * inventory invariants (GIST exclusion, hold semantics, atomic claim) are
 * identical regardless of which surface created the booking.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { bookings, slots } from '../db/schema/index.js';
import { BadRequest, Forbidden, NotFound } from '../lib/errors.js';
import { requireApiKey } from '../middleware/require_api_key.js';
import { bookSlots } from '../services/booking_service.js';
import { getArenaById, listArenas } from '../services/arena_service.js';
import { listSlots } from '../services/slot_service.js';
import { getVenueById } from '../services/venue_service.js';

const bookSlotsSchema = z.object({
  slotIds: z.array(z.string().uuid()).min(1),
  customer: z.object({
    name: z.string().min(1),
    contact: z.string().min(1),
    note: z.string().optional(),
  }),
});

const availabilitySchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
  arenaId: z.string().uuid().optional(),
});

export const publicBookingRoutes: FastifyPluginAsync = async (app) => {
  // ──────────────────────────────────────────────────────────────────────────
  // GET /api/v1/venues/:id/availability
  //
  // Returns open slots for a venue (across one or all arenas) inside [from, to).
  // Mirrors the internal arena-slots endpoint; scope comes from `apiKey.tenantId`.
  // ──────────────────────────────────────────────────────────────────────────
  app.get(
    '/api/v1/venues/:id/availability',
    { preHandler: requireApiKey },
    async (req) => {
      const { id: venueId } = req.params as { id: string };
      const parsed = availabilitySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new BadRequest('Invalid availability query', 'bad_request', {
          issues: parsed.error.issues,
        });
      }
      const venue = await getVenueById(venueId);
      if (!venue) throw new NotFound('Venue not found', 'venue_not_found');

      // Tenant scoping: platform keys (apiTenantId === null) get cross-tenant
      // access (used by ops); tenant-scoped keys must match the venue's tenant.
      const apiTenantId = req.apiTenantId ?? null;
      if (apiTenantId !== null && venue.tenantId !== apiTenantId) {
        throw new Forbidden('Venue belongs to a different tenant', 'venue_forbidden');
      }

      const { from, to, arenaId } = parsed.data;
      const arenaList = arenaId ? [{ id: arenaId } as { id: string }] : await listArenas(venueId);

      // Same listSlots path as the internal route — no duplicated SQL.
      const arenaSlots = await Promise.all(
        arenaList.map(async (a) => ({
          arenaId: a.id,
          slots: (await listSlots(a.id, from, to)).filter((s) => s.status === 'open'),
        })),
      );

      return { venueId, from, to, arenas: arenaSlots };
    },
  );

  // ──────────────────────────────────────────────────────────────────────────
  // POST /api/v1/bookings
  //
  // Same code path as POST /v1/bookings (calls `bookSlots`), but stamped with
  // `channel='aggregator'` after the booking row lands. We do the channel
  // overwrite as a follow-up UPDATE because we can't modify `booking_service.ts`
  // in this phase; both surfaces share the inventory + audit work bookSlots()
  // already does.
  // ──────────────────────────────────────────────────────────────────────────
  app.post(
    '/api/v1/bookings',
    { preHandler: requireApiKey },
    async (req, reply) => {
      // Enforce the API key's role: only write/admin keys may create bookings.
      const role = req.apiKey?.role;
      if (role !== 'write' && role !== 'admin') {
        throw new Forbidden('API key is not authorized to write', 'api_key_write_forbidden');
      }

      const parsed = bookSlotsSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new BadRequest('Invalid booking payload', 'bad_request', {
          issues: parsed.error.issues,
        });
      }
      const { slotIds, customer } = parsed.data;

      // Resolve venue/tenant from the first slot.
      const firstSlotRows = await db
        .select()
        .from(slots)
        .where(and(eq(slots.id, slotIds[0]!), sql`${slots.deletedAt} is null`))
        .limit(1);
      if (firstSlotRows.length === 0) throw new NotFound('Slot not found', 'slot_not_found');

      const arena = await getArenaById(firstSlotRows[0]!.arenaId);
      if (!arena) throw new NotFound('Arena not found', 'arena_not_found');
      const venue = await getVenueById(arena.venueId);
      if (!venue) throw new NotFound('Venue not found', 'venue_not_found');

      const apiTenantId = req.apiTenantId ?? null;
      if (apiTenantId !== null && venue.tenantId !== apiTenantId) {
        throw new Forbidden('Venue belongs to a different tenant', 'venue_forbidden');
      }

      const tenantId = venue.tenantId;
      // The API key itself is the "actor" — no human user. We don't have a
      // dedicated `api_key_user` row yet, so we use the api_key.id as the actor
      // marker in audit. The audit table allows null actorUserId, but bookings
      // requires created_by_user_id to be a real user FK. For aggregator-issued
      // bookings, we leave the audit actor as null by using a synthetic ctx.
      // To keep bookings.created_by_user_id satisfied we use the requesting
      // API key's lookup: tenants always have at least one member; pick any
      // owner-level member as the system actor for now. (Production hardening:
      // create a dedicated system user per tenant for API-issued bookings.)
      const ctxUserId = await resolveSystemActorUserId(tenantId);

      const booking = await bookSlots(
        { tenantId, actorUserId: ctxUserId },
        venue.id,
        {
          slotIds,
          customerName: customer.name,
          customerContact: customer.contact,
          note: customer.note ?? null,
        },
      );

      // Stamp aggregator channel (overrides the bookSlots() default of 'walkin').
      const [updated] = await db
        .update(bookings)
        .set({ channel: 'aggregator' })
        .where(eq(bookings.id, booking.id))
        .returning();

      return reply.status(201).send(updated ?? booking);
    },
  );
};

/**
 * Pick a tenant_members row as the system actor for an aggregator-created
 * booking. Production hardening: replace with a dedicated `kind='system'` user
 * per tenant, created at tenant-onboard time. For Phase 17 we lean on the
 * existing owner.
 */
async function resolveSystemActorUserId(tenantId: string): Promise<string> {
  const rows = await db.execute<Record<string, unknown>>(sql`
    SELECT user_id FROM tenant_members
    WHERE tenant_id = ${tenantId}
    ORDER BY CASE role
               WHEN 'owner'    THEN 0
               WHEN 'manager'  THEN 1
               WHEN 'staff'    THEN 2
               WHEN 'readonly' THEN 3
               ELSE 4
             END, created_at
    LIMIT 1
  `);
  const row = (rows as unknown as Record<string, unknown>[])[0];
  if (!row) throw new NotFound('No tenant member to act as system user', 'no_system_actor');
  return row['user_id'] as string;
}
