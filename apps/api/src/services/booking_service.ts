import { and, eq, getTableColumns, inArray, ne, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type Booking, bookings, slots, tenants } from '../db/schema/index.js';
import { events } from '../db/schema/events.js';
import { payments } from '../db/schema/payments.js';
import type { PostBookingRedirect } from '../db/schema/post_booking_redirect.js';
import { BadRequest, Conflict, NotFound } from '../lib/errors.js';
import { type AuditCtx, writeAudit } from '../lib/audit.js';
import { publicKeyIdFor, type PaymentProviderId } from '../lib/gateway.js';
import { createPaymentOrder, resolvePaymentContext } from './payments_service.js';
import * as paymentsService from './payments_service.js';
import { onBookingConfirmed } from './notification_hooks.js';
import { revokeQrTicketsForBooking } from './qr_ticket_service.js';
import { computeCheckout } from './checkout_pricing.js';
import {
  buildBillingMetadata,
  computeChargeSnapshots,
  resolveBillingConfig,
} from './billing_config.js';
import { recordRedemption } from './coupon_service.js';
import type { Coupon } from '../db/schema/coupons.js';
import { eventBookingTickets } from '../db/schema/event_booking_tickets.js';
import {
  saveRegistrationAnswers,
  type RegistrationAnswerInput,
} from './event_registration_questions_service.js';
import { eventTicketTiers } from '../db/schema/event_ticket_tiers.js';

/** One ticket-tier line in an event booking: which tier and how many seats. */
export interface EventLine {
  tierId: string;
  quantity: number;
}

/** A resolved coupon + who funds the discount, threaded into the booking flows. */
export interface CouponPricing {
  coupon: Coupon;
  funder: 'org' | 'platform';
}

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

  // Walk-ins are paid at the counter (no gateway), but the row still records
  // the venue's currency so reporting/exports label the amount correctly.
  const payCtx = await resolvePaymentContext({ venueId, tenantId: ctx.tenantId });

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
        currency: payCtx.currency,
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

/**
 * Online-booking (Channel A) preparation. Phase 12 (Track B).
 *
 * Difference vs walk-in `bookSlots()`:
 *   - the bookings row goes in as `status='pending'` + `channel='circls'` +
 *     `paymentMethod='razorpay_route'`; it only transitions to `confirmed`
 *     when the `payment.captured` webhook fires.
 *   - the slots are still claimed atomically (to prevent two carts from
 *     colliding), but with `status='booked'` and `booking_id` pointing at the
 *     pending booking — abandoned-cart sweep frees them again if no capture
 *     arrives within `ABANDONED_CART_GRACE_MIN`.
 *   - a Razorpay order (Circls as merchant) is created via
 *     `payments_service.createPaymentOrder` and its id is returned so the frontend
 *     can hand off to Razorpay's checkout. Commission is taken at payout time,
 *     not at order time.
 *
 * Returns `{ bookingId, payment: { orderId, keyId } }` so the partner-portal /
 * consumer app has the minimum payload to open Razorpay's checkout widget.
 */
export interface PrepareOnlineBookingInput {
  slotIds: string[];
  customerName: string;
  customerContact: string;
  note?: string | null;
  /** The customer's own user id when they book for themselves (consumer flow).
   *  Distinct from the audit actor: a staff-created booking must NOT stamp the
   *  staff member as the customer. Drives notification contact lookup. */
  customerUserId?: string | null;
}

export interface PrepareOnlineBookingResult {
  bookingId: string;
  payment: {
    gateway: PaymentProviderId;
    orderId: string;
    /** The gateway's browser-safe key: Razorpay key id / Stripe publishable key. */
    keyId: string;
    /** Stripe only: what the browser needs to confirm the PaymentIntent. */
    clientSecret?: string | undefined;
    /** Amount in the currency's minor unit (paise / cents). */
    amountPaise: number;
    currency: string;
  };
}

export async function prepareOnlineBookingWithPayment(
  ctx: AuditCtx,
  venueId: string,
  input: PrepareOnlineBookingInput,
  pricing?: CouponPricing | null,
): Promise<PrepareOnlineBookingResult> {
  if (input.slotIds.length === 0) throw new Conflict('No slots selected', 'no_slots');

  // Gateway + currency follow the venue's country (Stripe/USD for US venues,
  // Razorpay/INR otherwise) — resolved up front so the gross-up, the booking
  // row, and the order all agree.
  const payCtx = await resolvePaymentContext({ venueId, tenantId: ctx.tenantId });

  // Same claim flow as walk-in, but staged: bookings.status='pending', and we
  // capture the price total so the Razorpay order has the right paise amount.
  const { bookingId, totalPaise, snapshots, billing, isFree } = await db.transaction(async (tx) => {
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

    if (sel.length !== input.slotIds.length) {
      throw new NotFound('Slot not found', 'slot_not_found');
    }
    if (sel.some((r) => r.startsInPast)) {
      throw new Conflict('This slot has already started', 'slot_in_past');
    }

    const total = sel.reduce((s, r) => s + r.pricePaise, 0);

    // Money model: discount + consumer commission + gross-up, shaped by the
    // tenant's billing knobs. A 100%/over-base coupon makes the booking free
    // (skip Razorpay). settleBase is the org's payout base: full base when
    // platform-funded, discounted base when org-funded — minus the org's
    // gateway-fee share.
    const billingCfg = await resolveBillingConfig({ tenantId: ctx.tenantId }, tx);
    const breakdown = computeCheckout(
      total,
      pricing
        ? {
            discountType: pricing.coupon.discountType,
            discountValue: pricing.coupon.discountValue,
            maxDiscountPaise: pricing.coupon.maxDiscountPaise,
          }
        : null,
      payCtx.provider,
      billingCfg,
    );
    const free = breakdown.totalPaise === 0;
    const preFeeSettleBase =
      pricing && pricing.funder === 'platform' ? total : breakdown.discountedBasePaise;
    const chargeSnapshots = computeChargeSnapshots(preFeeSettleBase, breakdown, billingCfg);

    // Circls is the merchant — the customer's payment lands in Circls's account.
    // No per-tenant KYC / Linked Account gate; the venue is paid out weekly,
    // net of commission, via the payouts workflow.
    const [booking] = await tx
      .insert(bookings)
      .values({
        tenantId: ctx.tenantId,
        venueId,
        itemType: 'slot',
        channel: 'circls',
        paymentMethod: free ? 'free' : 'razorpay_route',
        status: free ? 'confirmed' : 'pending',
        customerUserId: input.customerUserId ?? null,
        customerName: input.customerName,
        customerContact: input.customerContact,
        note: input.note ?? null,
        basePaise: total,
        discountPaise: breakdown.discountPaise,
        couponId: pricing?.coupon.id ?? null,
        totalPaise: breakdown.totalPaise,
        currency: payCtx.currency,
        createdByUserId: ctx.actorUserId,
      })
      .returning();

    // Atomic claim — same rules as walk-in (open / own-hold / expired-hold).
    const claimed = await tx
      .update(slots)
      .set({ status: 'booked', bookingId: booking!.id, holdExpiresAt: null, heldByUserId: null })
      .where(
        and(
          inArray(slots.id, input.slotIds),
          eq(slots.tenantId, ctx.tenantId),
          sql`${slots.deletedAt} is null`,
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

    // Single-court bookings record their arena + time-span on the booking row so
    // the per-arena GIST overlap guard applies and a later cancellation (which
    // nulls slots.booking_id) keeps a fallback arena/window for the read paths.
    // A cart can span arenas: such a booking leaves slot_arena_id NULL — the
    // GIST exclusion's `=` skips NULLs, and the atomic per-slot claim above is
    // the real double-booking guard. The slots keep their own arena for display.
    const distinctArenas = new Set(claimed.map((c) => c.arenaId));
    const singleArenaId = distinctArenas.size === 1 ? claimed[0]!.arenaId : null;

    await tx
      .update(bookings)
      .set({
        slotArenaId: singleArenaId,
        timeRange: singleArenaId
          ? sql`(select tstzrange(min(lower(time_range)), max(upper(time_range)), '[)') from slots where booking_id = ${booking!.id})`
          : null,
      })
      .where(eq(bookings.id, booking!.id));

    // When a coupon applies, record the redemption inside the booking tx so a
    // lost cap race rolls the whole booking back (and frees the claimed slots).
    if (pricing) {
      await recordRedemption(tx, {
        coupon: pricing.coupon,
        bookingId: booking!.id,
        userId: ctx.actorUserId,
        tenantId: ctx.tenantId,
        basePaise: total,
        discountPaise: breakdown.discountPaise,
        funder: pricing.funder,
      });
    }

    await writeAudit(tx, ctx, 'booking.create_pending', 'booking', booking!.id, null, {
      slotIds: input.slotIds,
      total,
      discountPaise: breakdown.discountPaise,
      totalPaise: breakdown.totalPaise,
      free,
      channel: 'circls',
      paymentMethod: free ? 'free' : 'razorpay_route',
    });

    return {
      bookingId: booking!.id,
      totalPaise: breakdown.totalPaise,
      snapshots: {
        ...chargeSnapshots,
        orgFeeSharePaise: breakdown.orgFeeSharePaise,
        gatewayFeeEstimatePaise: breakdown.gatewayFeeEstimatePaise,
      },
      billing: billingCfg,
      isFree: free,
    };
  });

  // Free booking (e.g. a 100%-off coupon): no Razorpay order, no payment row.
  // Confirmed inline, so there's no payment-captured webhook to send the
  // confirmation — dispatch it here (best-effort, never throws).
  if (isFree) {
    await onBookingConfirmed(bookingId);
    return {
      bookingId,
      payment: {
        gateway: payCtx.provider,
        orderId: '',
        keyId: '',
        amountPaise: 0,
        currency: payCtx.currency,
      },
    };
  }

  // Create the order outside the booking transaction so a network blip talking
  // to the gateway doesn't roll back the pending booking + slot claim. If
  // createPaymentOrder ultimately fails, the abandoned-cart sweep will clean the
  // pending booking after the grace window.
  const { paymentId: _paymentId, providerOrderId, clientSecret } = await createPaymentOrder({
    bookingId,
    tenantId: ctx.tenantId,
    amountPaise: totalPaise,
    settleBasePaise: snapshots.settleBasePaise,
    consumerCommissionPaise: snapshots.consumerCommissionPaise,
    partnerCommissionPaise: snapshots.partnerCommissionPaise,
    advancePaise: snapshots.advancePaise,
    billingMetadata: buildBillingMetadata(billing, snapshots),
    provider: payCtx.provider,
    currency: payCtx.currency,
    actorUserId: ctx.actorUserId,
  });

  return {
    bookingId,
    payment: {
      gateway: payCtx.provider,
      orderId: providerOrderId,
      // Frontend uses this to open checkout (Razorpay JS / Stripe.js). Stub
      // mode has no key; we surface an empty string so the response shape
      // stays stable and the client shows "reserved".
      keyId: publicKeyIdFor(payCtx.provider),
      ...(clientSecret !== undefined ? { clientSecret } : {}),
      amountPaise: totalPaise,
      currency: payCtx.currency,
    },
  };
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

    await revokeQrTicketsForBooking(bookingId, tx);

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
  /** Which gateway the order was minted on (paid only). */
  gateway?: PaymentProviderId;
  /** The gateway's browser-safe key + amount, so the client can open checkout. */
  keyId?: string;
  /** Stripe only: what the browser needs to confirm the PaymentIntent. */
  clientSecret?: string | undefined;
  amountPaise?: number;
  currency?: string;
  /**
   * The event's post-booking link, if the partner set one. Present ONLY on the
   * free path, where the booking is already `confirmed` when we return. The
   * paid path deliberately omits it: at that point the booking is still
   * `pending`, so returning it would hand the organiser's form/group link to
   * anyone who starts a checkout and never pays. Paid bookers pick it up from
   * `GET /v1/consumer/me/bookings/:id` once the payment webhook confirms them.
   */
  postBookingRedirect?: PostBookingRedirect | null;
}

export interface ExternalRegistrationInput {
  /** Who attended. Free text — there is no account behind this booking. */
  name: string;
  /** Phone or email, if the partner captured one. */
  contact?: string | null;
  lines: EventLine[];
  answers?: RegistrationAnswerInput[];
  note?: string | null;
}

/**
 * Record a registration the partner took off-platform — at the door, over the
 * phone, through their own form — so their event roll is complete.
 *
 * It is a real registration in every way that constrains the event: it claims
 * seats through the same {@link claimEventSeats} the consumer checkout uses, so
 * per-tier capacity counts it, and required registration questions must be
 * answered here too (saveRegistrationAnswers enforces that). The per-person cap
 * is the one rule it escapes, and only because it must: there is no account to
 * attribute tickets to.
 *
 * It is deliberately invisible to money. No payment row is written, and payouts
 * are computed purely from `payments` — so this can never reach a settlement,
 * commission or advance. Totals are stored as zero rather than the tier price
 * because Circls processed nothing; whatever the attendee paid was collected by
 * the partner directly. `payment_method = 'external'` is what distinguishes
 * that from a genuinely free ticket.
 */
export async function addExternalEventRegistration(
  ctx: AuditCtx,
  eventId: string,
  input: ExternalRegistrationInput,
): Promise<{ bookingId: string }> {
  const name = input.name.trim();
  if (!name) throw new BadRequest('A name is required', 'bad_request');
  if (input.lines.length === 0) throw new Conflict('No tickets selected', 'no_tickets');
  const tierIds = input.lines.map((l) => l.tierId);
  if (new Set(tierIds).size !== tierIds.length) {
    throw new BadRequest('Duplicate ticket tier in request', 'bad_request');
  }

  const bookingId = await db.transaction(async (tx) => {
    const [ev] = await tx
      .select()
      .from(events)
      .where(and(eq(events.id, eventId), eq(events.tenantId, ctx.tenantId)))
      .limit(1);
    if (!ev) throw new NotFound('Event not found', 'event_not_found');
    if (ev.status !== 'published') {
      throw new Conflict(
        'Only a published event can take registrations',
        'event_not_published',
        { status: ev.status },
      );
    }

    // No userId: this attendee has no circls account, so the per-person cap
    // cannot be attributed to them. Per-tier capacity still applies.
    const { lineValues } = await claimEventSeats(tx, ev, input.lines, null);

    const payCtx = await resolvePaymentContext({ venueId: ev.venueId, tenantId: ev.tenantId }, tx);

    const [b] = await tx
      .insert(bookings)
      .values({
        tenantId: ev.tenantId,
        venueId: ev.venueId,
        itemType: 'event',
        channel: 'walkin',
        paymentMethod: 'external',
        status: 'confirmed',
        customerUserId: null,
        customerName: name,
        customerContact: input.contact?.trim() || null,
        note: input.note?.trim() || null,
        pricePaise: 0,
        basePaise: 0,
        discountPaise: 0,
        totalPaise: 0,
        currency: payCtx.currency,
        itemData: { eventId: ev.id, eventName: ev.name },
        createdByUserId: ctx.actorUserId,
      })
      .returning();
    if (!b) throw new Error('booking insert returned no row');

    // Quantities drive the tier sold counts; prices stay zero for the same
    // reason the booking total does.
    await tx.insert(eventBookingTickets).values(
      lineValues.map((l) => ({
        bookingId: b.id,
        tierId: l.tierId,
        quantity: l.quantity,
        unitPricePaise: 0,
      })),
    );

    // Rejects a missing required answer, so the partner cannot skip questions
    // the consumer flow would have forced.
    await saveRegistrationAnswers(tx, ev.id, b.id, input.answers ?? []);

    await writeAudit(tx, ctx, 'event.registration_added', 'booking', b.id, null, {
      eventId: ev.id,
      name,
      tickets: lineValues.reduce((sum, l) => sum + l.quantity, 0),
      channel: 'walkin',
    });

    return b.id;
  });

  // Outside the transaction, exactly as the other confirmed paths do: issues QR
  // entry passes so the attendee can be checked in at the door, and notifies
  // them if a contact was captured. Best-effort — never throws.
  await onBookingConfirmed(bookingId);

  return { bookingId };
}

/** The transaction handle drizzle hands a db.transaction callback. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Seat claim shared by every way an event gets booked: the consumer checkout
 * and the partner's own external-registration entry.
 *
 * Kept in one place deliberately — capacity and the per-person cap are the
 * rules a partner relies on being true, and two copies would drift the moment
 * one path changed. Callers differ only in `userId`: a registration entered on
 * behalf of someone who signed up off-platform has no account behind it, so the
 * per-person cap cannot be attributed and is skipped. Per-tier capacity always
 * applies — a seat is a seat however it was filled.
 *
 * Must run inside a transaction: it takes row locks in event -> tier order.
 */
async function claimEventSeats(
  tx: Tx,
  ev: typeof events.$inferSelect,
  lines: EventLine[],
  userId: string | null,
): Promise<{
  basePaise: number;
  lineValues: { tierId: string; quantity: number; unitPricePaise: number }[];
}> {
  const tierIds = lines.map((l) => l.tierId);

  // Per-customer event cap: the buyer's tickets for this event — summed
  // across ALL tiers and all their non-cancelled bookings — plus this request
  // may not exceed event.maxPerUser. The event row is locked first (before
  // the tier locks below, keeping one event→tier lock order) so two
  // concurrent bookings by the same user serialize rather than both passing.
  if (ev.maxPerUser !== null && userId !== null) {
    await tx
      .select({ id: events.id })
      .from(events)
      .where(eq(events.id, ev.id))
      .for('update');
    const requested = lines.reduce((sum, l) => sum + l.quantity, 0);
    const [row] = await tx
      .select({ held: sql<number>`coalesce(sum(${eventBookingTickets.quantity}), 0)::int` })
      .from(eventBookingTickets)
      .innerJoin(eventTicketTiers, eq(eventTicketTiers.id, eventBookingTickets.tierId))
      .innerJoin(bookings, eq(bookings.id, eventBookingTickets.bookingId))
      .where(
        and(
          eq(eventTicketTiers.eventId, ev.id),
          ne(bookings.status, 'cancelled'),
          eq(bookings.customerUserId, userId),
        ),
      );
    const held = row?.held ?? 0;
    if (held + requested > ev.maxPerUser) {
      throw new Conflict(
        held >= ev.maxPerUser
          ? `You've already booked the maximum of ${ev.maxPerUser} ticket${ev.maxPerUser > 1 ? 's' : ''} for this event`
          : `This event is limited to ${ev.maxPerUser} ticket${ev.maxPerUser > 1 ? 's' : ''} per person`,
        'event_user_limit',
        { maxPerUser: ev.maxPerUser, held },
      );
    }
  }

  // Lock the referenced tiers (serialize concurrent buyers), validate ownership,
  // and enforce per-tier capacity using the line-table sold count.
  const tiers = await tx
    .select()
    .from(eventTicketTiers)
    .where(
      and(
        inArray(eventTicketTiers.id, tierIds),
        eq(eventTicketTiers.eventId, ev.id),
        sql`${eventTicketTiers.deletedAt} is null`,
      ),
    )
    .for('update');
  const tierById = new Map(tiers.map((t) => [t.id, t]));

  let basePaise = 0;
  const lineValues: { tierId: string; quantity: number; unitPricePaise: number }[] = [];
  for (const line of lines) {
    const tier = tierById.get(line.tierId);
    if (!tier) throw new BadRequest('Unknown ticket tier for this event', 'bad_request');
    if (line.quantity <= 0) throw new BadRequest('Quantity must be positive', 'bad_request');
    if (tier.capacity !== null) {
      const [row] = await tx
        .select({ sold: sql<number>`coalesce(sum(${eventBookingTickets.quantity}), 0)::int` })
        .from(eventBookingTickets)
        .innerJoin(bookings, eq(bookings.id, eventBookingTickets.bookingId))
        .where(and(eq(eventBookingTickets.tierId, tier.id), ne(bookings.status, 'cancelled')));
      const sold = row?.sold ?? 0;
      if (sold + line.quantity > tier.capacity) {
        throw new Conflict('Tier sold out', 'tier_sold_out', { tierId: tier.id });
      }
    }
    basePaise += tier.pricePaise * line.quantity;
    lineValues.push({ tierId: tier.id, quantity: line.quantity, unitPricePaise: tier.pricePaise });
  }
  return { basePaise, lineValues };
}

/**
 * Book a seat on a published event.
 *
 * Capacity check (per-tier):
 *   - The booking is composed of `lines` (one per ticket tier + quantity). We
 *     SELECT ... FOR UPDATE the referenced tiers inside the booking transaction
 *     to serialize concurrent buyers, then for each capped tier compare the
 *     line-table sold count (SUM(quantity) over non-cancelled bookings) plus the
 *     requested quantity against the tier capacity, rejecting with a
 *     `tier_sold_out` Conflict if it would exceed. basePaise is the sum of
 *     tier.pricePaise * quantity across the lines (event.pricePaise is only the
 *     min-tier display price and is NOT used for charging).
 *
 * Per-customer cap (event-level): when event.maxPerUser is set, the buyer's
 *   total tickets for the event — across ALL tiers and all their non-cancelled
 *   bookings — may not exceed it (`event_user_limit` Conflict).
 *
 * Free path  (basePaise === 0): inserts booking with status='confirmed',
 *   paymentMethod='free'. No KYC check.
 *
 * Paid path: Circls is the merchant (no per-tenant KYC / Linked Account).
 *   Inserts booking status='pending' + payments row kind='charge', then calls
 *   `payments_service.createPaymentOrder`. If Phase 12 isn't ready, surfaces a
 *   `payment_not_available` Conflict (the wrapping transaction rolls back).
 */
export async function bookEvent(
  eventId: string,
  customer: BookEventCustomer,
  pricing: CouponPricing | null,
  lines: EventLine[],
  answers: RegistrationAnswerInput[] = [],
): Promise<BookEventResult> {
  // Phase 1 — atomic seat reservation. The booking row goes into the DB inside
  // a transaction so capacity check + insert are race-safe.
  const reserved = await db.transaction(async (tx) => {
    const [ev] = await tx
      .select()
      .from(events)
      .where(eq(events.id, eventId))
      .limit(1);
    if (!ev) throw new NotFound('Event not found', 'event_not_found');
    if (ev.status !== 'published') {
      throw new Conflict('Event is not published', 'event_not_published');
    }
    const ctx: AuditCtx = { tenantId: ev.tenantId, actorUserId: customer.userId };

    if (lines.length === 0) throw new Conflict('No tickets selected', 'no_tickets');

    const tierIds = lines.map((l) => l.tierId);
    if (new Set(tierIds).size !== tierIds.length) {
      throw new BadRequest('Duplicate ticket tier in request', 'bad_request');
    }

    const { basePaise, lineValues } = await claimEventSeats(tx, ev, lines, customer.userId);

    // Gateway + currency follow the event's venue country (fallback: tenant).
    const payCtx = await resolvePaymentContext(
      { venueId: ev.venueId, tenantId: ev.tenantId },
      tx,
    );

    // Money model: discount + consumer commission + gross-up, shaped by the
    // billing knobs (event overrides beat tenant defaults — ev is already
    // loaded, so resolution costs one tenants select). A 100%/over-base coupon
    // can make a paid event free, so derive isFree from the grossed-up total,
    // not the base.
    const billingCfg = await resolveBillingConfig(
      {
        tenantId: ev.tenantId,
        eventOverrides: {
          partnerCommissionBps: ev.partnerCommissionBps,
          consumerCommissionBps: ev.consumerCommissionBps,
          advancePayoutBps: ev.advancePayoutBps,
        },
      },
      tx,
    );
    const breakdown = computeCheckout(
      basePaise,
      pricing
        ? {
            discountType: pricing.coupon.discountType,
            discountValue: pricing.coupon.discountValue,
            maxDiscountPaise: pricing.coupon.maxDiscountPaise,
          }
        : null,
      payCtx.provider,
      billingCfg,
    );
    const isFree = breakdown.totalPaise === 0;
    const preFeeSettleBase =
      pricing && pricing.funder === 'platform' ? basePaise : breakdown.discountedBasePaise;
    const chargeSnapshots = computeChargeSnapshots(preFeeSettleBase, breakdown, billingCfg);
    // Circls is the merchant — no per-tenant KYC / Linked Account gate.

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
        pricePaise: basePaise,
        basePaise,
        discountPaise: breakdown.discountPaise,
        couponId: pricing?.coupon.id ?? null,
        totalPaise: breakdown.totalPaise,
        currency: payCtx.currency,
        itemData: { eventId: ev.id, eventName: ev.name },
        createdByUserId: ctx.actorUserId,
      })
      .returning();
    if (!b) throw new Error('booking insert returned no row');

    await tx.insert(eventBookingTickets).values(
      lineValues.map((l) => ({
        bookingId: b.id,
        tierId: l.tierId,
        quantity: l.quantity,
        unitPricePaise: l.unitPricePaise,
      })),
    );

    // Registration-question answers are validated against the event's live
    // questions (required ones must be present) and stored with the booking.
    await saveRegistrationAnswers(tx, ev.id, b.id, answers);

    // Record the redemption inside the same tx so a lost cap race rolls the
    // booking (and capacity claim) back together.
    if (pricing) {
      await recordRedemption(tx, {
        coupon: pricing.coupon,
        bookingId: b.id,
        userId: customer.userId,
        tenantId: ev.tenantId,
        basePaise,
        discountPaise: breakdown.discountPaise,
        funder: pricing.funder,
      });
    }

    await writeAudit(tx, ctx, 'event.booked', 'booking', b.id, null, {
      eventId: ev.id,
      free: isFree,
    });

    return {
      booking: b,
      isFree,
      tenantId: ev.tenantId,
      eventName: ev.name,
      totalPaise: breakdown.totalPaise,
      snapshots: {
        ...chargeSnapshots,
        orgFeeSharePaise: breakdown.orgFeeSharePaise,
        gatewayFeeEstimatePaise: breakdown.gatewayFeeEstimatePaise,
      },
      billing: billingCfg,
      payCtx,
      postBookingRedirect: ev.postBookingRedirect,
    };
  });

  if (reserved.isFree) {
    // Free events confirm inline (no payment webhook) — notify from here. The
    // booking IS confirmed at this point, so the post-booking link is earned.
    await onBookingConfirmed(reserved.booking.id);
    return {
      booking: reserved.booking,
      postBookingRedirect: reserved.postBookingRedirect,
    };
  }

  // Phase 2 — paid path: createPaymentOrder runs OUTSIDE the booking tx so it
  // can see the committed booking row (it inserts payments referencing it).
  // Mirrors prepareOnlineBookingWithPayment's split-tx pattern; if the gateway
  // fails here, the abandoned-cart sweep cancels the pending booking after the
  // grace window.
  let providerOrderId: string | undefined;
  let paymentId: string | undefined;
  let clientSecret: string | undefined;
  try {
    const result = await paymentsService.createPaymentOrder({
      bookingId: reserved.booking.id,
      tenantId: reserved.tenantId,
      amountPaise: reserved.totalPaise,
      settleBasePaise: reserved.snapshots.settleBasePaise,
      consumerCommissionPaise: reserved.snapshots.consumerCommissionPaise,
      partnerCommissionPaise: reserved.snapshots.partnerCommissionPaise,
      advancePaise: reserved.snapshots.advancePaise,
      billingMetadata: buildBillingMetadata(reserved.billing, reserved.snapshots),
      provider: reserved.payCtx.provider,
      currency: reserved.payCtx.currency,
      actorUserId: customer.userId,
    });
    providerOrderId = result.providerOrderId;
    paymentId = result.paymentId;
    clientSecret = result.clientSecret;
  } catch (err) {
    if (err instanceof Error && err.message.includes('not implemented')) {
      throw new Conflict('Payments not yet enabled', 'payment_not_available');
    }
    throw err;
  }

  return {
    booking: reserved.booking,
    paymentId,
    providerOrderId,
    gateway: reserved.payCtx.provider,
    keyId: publicKeyIdFor(reserved.payCtx.provider),
    ...(clientSecret !== undefined ? { clientSecret } : {}),
    amountPaise: reserved.totalPaise,
    currency: reserved.payCtx.currency,
    // No postBookingRedirect here on purpose — see the field's doc comment.
    // This booking is 'pending' until the gateway webhook confirms it.
  };
}
