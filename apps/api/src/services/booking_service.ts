import { and, eq, getTableColumns, inArray, ne, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type Booking, bookings, slots } from '../db/schema/index.js';
import { events } from '../db/schema/events.js';
import { payments } from '../db/schema/payments.js';
import { tenants } from '../db/schema/tenants.js';
import { Conflict, NotFound } from '../lib/errors.js';
import { type AuditCtx, writeAudit } from '../lib/audit.js';
import * as paymentsService from './payments_service.js';

export interface BookSlotsInput {
  slotIds: string[];
  customerName: string;
  customerContact: string;
  note?: string | null;
}

export async function bookSlots(
  ctx: AuditCtx,
  venueId: string,
  input: BookSlotsInput,
): Promise<Booking> {
  if (input.slotIds.length === 0) throw new Conflict('No slots selected', 'no_slots');

  return db.transaction(async (tx) => {
    const sel = await tx
      .select({
        ...getTableColumns(slots),
        startsInPast: sql<boolean>`lower(${slots.timeRange}) <= now()`,
      })
      .from(slots)
      .where(
        and(
          inArray(slots.id, input.slotIds),
          eq(slots.tenantId, ctx.tenantId),
          sql`${slots.deletedAt} is null`,
        ),
      );

    // A slot whose start instant has passed can no longer be booked.
    if (sel.some((r) => r.startsInPast)) {
      throw new Conflict('This slot has already started', 'slot_in_past');
    }

    const total = sel.reduce((s, r) => s + r.pricePaise, 0);

    const [booking] = await tx
      .insert(bookings)
      .values({
        tenantId: ctx.tenantId,
        venueId,
        itemType: 'slot',
        channel: 'walkin',
        paymentMethod: 'external',
        status: 'confirmed',
        customerName: input.customerName,
        customerContact: input.customerContact,
        note: input.note ?? null,
        totalPaise: total,
        createdByUserId: ctx.actorUserId,
      })
      .returning();

    // Atomic claim: take slots that are open, OR held by the booking actor
    // (their own active hold), OR held-but-expired (reclaimable from anyone).
    // Using inArray() avoids the any(array::uuid[]) record-cast error from postgres-js.
    // eq(slots.tenantId, ctx.tenantId) guards against cross-tenant slot injection:
    // a member of tenant A passing slotIds from tenant B would otherwise claim B's slots.
    const claimed = await tx
      .update(slots)
      .set({ status: 'booked', bookingId: booking!.id, holdExpiresAt: null, heldByUserId: null })
      .where(
        and(
          inArray(slots.id, input.slotIds),
          eq(slots.tenantId, ctx.tenantId),
          sql`${slots.deletedAt} is null`,
          // TOCTOU guard: never claim a slot whose start has passed.
          sql`lower(${slots.timeRange}) > now()`,
          or(
            eq(slots.status, 'open'),
            and(
              eq(slots.status, 'held'),
              or(eq(slots.heldByUserId, ctx.actorUserId), sql`${slots.holdExpiresAt} < now()`),
            ),
          ),
        ),
      )
      .returning();

    if (claimed.length !== input.slotIds.length) {
      throw new Conflict('Slot already taken', 'slot_taken');
    }

    // Persist the booking's own arena + time-span so that cancelled bookings
    // (which null slots.booking_id) still have an arena + window the read paths
    // can fall back to. Single-arena booking model: all claimed slots must
    // share one arena — assert so future multi-arena designs surface loudly.
    const claimedArenaId = claimed[0]!.arenaId;
    if (!claimed.every((c) => c.arenaId === claimedArenaId)) {
      throw new Conflict('Multi-arena booking not supported', 'multi_arena_booking');
    }

    await tx
      .update(bookings)
      .set({
        slotArenaId: claimedArenaId,
        // The sub-SELECT computes the span from the slots we just linked
        // (booking_id was set in the UPDATE above), as their definitive span.
        timeRange: sql`(select tstzrange(min(lower(time_range)), max(upper(time_range)), '[)') from slots where booking_id = ${booking!.id})`,
      })
      .where(eq(bookings.id, booking!.id));

    await writeAudit(tx, ctx, 'booking.create', 'booking', booking!.id, null, {
      slotIds: input.slotIds,
      total,
    });

    return booking!;
  });
}

export async function cancelBooking(ctx: AuditCtx, bookingId: string): Promise<Booking> {
  return db.transaction(async (tx) => {
    const [b] = await tx
      .update(bookings)
      .set({ status: 'cancelled' })
      .where(
        and(eq(bookings.id, bookingId), eq(bookings.tenantId, ctx.tenantId)),
      )
      .returning();

    if (!b) throw new NotFound('Booking not found', 'booking_not_found');

    await tx
      .update(slots)
      .set({ status: 'open', bookingId: null })
      .where(and(eq(slots.bookingId, bookingId), sql`${slots.deletedAt} is null`));

    await writeAudit(tx, ctx, 'booking.cancel', 'booking', bookingId, null, null);

    return b;
  });
}

// ── Event bookings (Phase 15) ───────────────────────────────────────────────

export interface BookEventCustomer {
  /** The authenticated user purchasing the seat. */
  userId: string;
  /** Display name persisted on the booking for reception lookup. */
  name?: string | null;
  /** Phone / email kept for notifications + walk-up reconciliation. */
  contact?: string | null;
  note?: string | null;
}

export type BookEventPaymentMethod = 'razorpay_route' | 'external' | 'free';

export interface BookEventResult {
  booking: Booking;
  paymentId?: string;
  providerOrderId?: string;
}

/**
 * Book a seat on a published event.
 *
 * Capacity check:
 *   - When event.capacity IS NOT NULL we COUNT non-cancelled bookings whose
 *     itemData->>'eventId' matches and reject if we'd exceed `capacity`. We
 *     do this inside the same transaction that performs the insert so two
 *     concurrent calls can't both squeeze under the limit; we additionally
 *     re-COUNT after the insert and roll back if the post-insert count is
 *     over capacity, which is the simple form of "select-then-insert with
 *     verification" — no GIST exclusion constraint exists for events because
 *     they aren't time-range based.
 *
 * Free path  (pricePaise === 0): inserts booking with status='confirmed',
 *   paymentMethod='free'. No KYC check.
 *
 * Paid path: tenant.kyc_status='verified' required; otherwise `kyc_required`.
 *   Inserts booking status='pending' + payments row kind='charge', then calls
 *   `payments_service.createRouteOrder`. If Phase 12 isn't ready, surfaces a
 *   `payment_not_available` Conflict (the wrapping transaction rolls back).
 */
export async function bookEvent(
  eventId: string,
  customer: BookEventCustomer,
): Promise<BookEventResult> {
  return db.transaction(async (tx) => {
    const [ev] = await tx
      .select()
      .from(events)
      .where(eq(events.id, eventId))
      .limit(1);
    if (!ev) throw new NotFound('Event not found', 'event_not_found');
    if (ev.status !== 'published') {
      throw new Conflict('Event is not published', 'event_not_published');
    }
    // Audit context: tenantId from the event, actor is the booking user.
    const ctx: AuditCtx = { tenantId: ev.tenantId, actorUserId: customer.userId };

    // Capacity check pre-insert. Counted bookings exclude cancelled rows so
    // freed seats can be resold.
    if (ev.capacity !== null) {
      const rows = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(bookings)
        .where(
          and(
            eq(bookings.itemType, 'event'),
            sql`${bookings.itemData}->>'eventId' = ${eventId}`,
            ne(bookings.status, 'cancelled'),
          ),
        );
      const n = rows[0]?.n ?? 0;
      if (n >= ev.capacity) {
        throw new Conflict('Event is at capacity', 'event_full');
      }
    }

    const isFree = ev.pricePaise === 0;

    let linkedAccountId: string | null = null;
    if (!isFree) {
      const [tenant] = await tx
        .select({
          kycStatus: tenants.kycStatus,
          linkedAccountId: tenants.razorpayLinkedAccountId,
        })
        .from(tenants)
        .where(eq(tenants.id, ev.tenantId))
        .limit(1);
      if (!tenant) throw new NotFound('Tenant not found', 'tenant_not_found');
      const ok = tenant.kycStatus === 'verified' && Boolean(tenant.linkedAccountId);
      if (!ok) throw new Conflict('Tenant KYC not verified', 'kyc_required');
      linkedAccountId = tenant.linkedAccountId ?? null;
    }

    const [b] = await tx
      .insert(bookings)
      .values({
        tenantId: ev.tenantId,
        venueId: ev.venueId,
        itemType: 'event',
        channel: 'circls',
        paymentMethod: isFree ? 'free' : 'razorpay_route',
        status: isFree ? 'confirmed' : 'pending',
        customerUserId: customer.userId,
        customerName: customer.name ?? null,
        customerContact: customer.contact ?? null,
        note: customer.note ?? null,
        pricePaise: ev.pricePaise,
        totalPaise: ev.pricePaise,
        itemData: { eventId: ev.id, eventName: ev.name },
        createdByUserId: ctx.actorUserId,
      })
      .returning();
    if (!b) throw new Error('booking insert returned no row');

    // Post-insert capacity re-verification — handles the race where two
    // transactions both pass the pre-check. Postgres serializes the COUNT
    // against the inserted row inside the same transaction.
    if (ev.capacity !== null) {
      const rows2 = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(bookings)
        .where(
          and(
            eq(bookings.itemType, 'event'),
            sql`${bookings.itemData}->>'eventId' = ${eventId}`,
            ne(bookings.status, 'cancelled'),
          ),
        );
      const n2 = rows2[0]?.n ?? 0;
      if (n2 > ev.capacity) {
        throw new Conflict('Event is at capacity', 'event_full');
      }
    }

    if (isFree) {
      await writeAudit(tx, ctx, 'event.booked', 'booking', b.id, null, {
        eventId: ev.id,
        free: true,
      });
      return { booking: b };
    }

    // Paid path — create the payment ledger row.
    const [p] = await tx
      .insert(payments)
      .values({
        bookingId: b.id,
        tenantId: ev.tenantId,
        provider: 'razorpay',
        amountPaise: ev.pricePaise,
        currency: 'INR',
        status: 'pending',
        kind: 'charge',
        metadata: { eventId: ev.id },
      })
      .returning();
    if (!p) throw new Error('payment insert returned no row');

    let providerOrderId: string | undefined;
    try {
      const result = await paymentsService.createRouteOrder({
        bookingId: b.id,
        tenantId: ev.tenantId,
        amountPaise: ev.pricePaise,
        linkedAccountId: linkedAccountId!,
        platformFeePaise: 0,
      });
      providerOrderId = result.providerOrderId;
    } catch (err) {
      if (err instanceof Error && err.message.includes('not implemented')) {
        throw new Conflict('Payments not yet enabled', 'payment_not_available');
      }
      throw err;
    }

    await writeAudit(tx, ctx, 'event.booked', 'booking', b.id, null, {
      eventId: ev.id,
      free: false,
      paymentId: p.id,
    });

    return { booking: b, paymentId: p.id, providerOrderId };
  });
}
