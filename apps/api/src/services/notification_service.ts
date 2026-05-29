/**
 * Notification service — wraps the lib/notifications dispatcher with the
 * application-level helpers (booking confirmation, KYC update, reminder
 * scheduling, OTP). Phase 13 implementation.
 *
 * Why this lives in services/ (not lib/): the helpers here join across
 * bookings + venues + tenant_members to assemble the template payload and
 * decide which channels to fan out to. The lib/notifications layer is a
 * channel-agnostic dispatcher — it doesn't know what a booking is.
 *
 * Channel selection rules (kept deliberately simple for Phase 13):
 *   booking confirmed/cancelled:
 *     - if contact looks like phone → SMS
 *     - if contact looks like email → email
 *     - if both phone + email present (via customer_contact_json) → fan out to
 *       both, plus WhatsApp when phone is present AND a WA provider is configured
 *   booking reminders (T-24h, T-1h):
 *     - only when phone is present; SMS always, WhatsApp when provider is set
 *   kyc state change:
 *     - tenant owner's email, via tenant_members WHERE role='owner' join users
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { getNotifications, type DispatchInput } from '../lib/notifications/index.js';
import type { NotificationChannel } from '../lib/notifications/templates.js';
import { tenantMembers } from '../db/schema/tenant_members.js';
import { tenants } from '../db/schema/tenants.js';
import { users } from '../db/schema/users.js';

/** Generic passthrough — kept thin so route handlers can call it. */
export async function dispatch(input: DispatchInput) {
  return getNotifications().dispatch(input);
}

/** Worker handler — runs every minute. Returns count of attempted sends. */
export async function processPendingNotifications(): Promise<number> {
  try {
    return await getNotifications().processPending();
  } catch (err) {
    logger.error({ err }, 'notifications_worker_failed');
    return 0;
  }
}

// ── Booking notification helpers ──────────────────────────────────────────────

interface BookingNotifyContext {
  bookingId: string;
  tenantId: string;
  customerName: string;
  customerUserId: string | null;
  phone: string | null;
  email: string | null;
  venueName: string;
  arenaName: string;
  startAt: Date | null;
  totalRupees: string;
  whenText: string;
}

const IST_FMT = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function isEmail(s: string): boolean {
  return /.+@.+\..+/.test(s);
}

function isPhone(s: string): boolean {
  // E.164-ish or local: starts with + or digit, mostly digits
  return /^\+?\d[\d\-\s]{6,}$/.test(s);
}

/**
 * Extract contact channels from a booking row. `customer_contact_json` is the
 * preferred source (structured `{ phone, email }`); we fall back to sniffing
 * the legacy `customer_contact` string.
 */
function extractContacts(
  customerContactJson: Record<string, unknown> | null,
  customerContact: string | null,
): { phone: string | null; email: string | null } {
  let phone: string | null = null;
  let email: string | null = null;

  if (customerContactJson && typeof customerContactJson === 'object') {
    const p = customerContactJson['phone'];
    const e = customerContactJson['email'];
    if (typeof p === 'string' && isPhone(p)) phone = p;
    if (typeof e === 'string' && isEmail(e)) email = e;
  }

  if (customerContact) {
    if (!phone && isPhone(customerContact)) phone = customerContact;
    if (!email && isEmail(customerContact)) email = customerContact;
  }

  return { phone, email };
}

/**
 * Load a booking + venue + arena + customer contact for a notification.
 * Returns null if the booking isn't found — callers no-op in that case.
 *
 * Why two queries: the slot-side data (start_at, arena name) is 1:N to the
 * booking when slots haven't been released, so we aggregate separately to
 * avoid GROUP BY gymnastics. The fallback arena name comes from the
 * booking's `slot_arena_id` snapshot when slots have been released
 * (cancelled-booking case).
 */
async function loadBookingContext(bookingId: string): Promise<BookingNotifyContext | null> {
  const bookingRows = await db.execute<Record<string, unknown>>(sql`
    select b.id                       as id,
           b.tenant_id                as tenant_id,
           b.customer_name            as customer_name,
           b.customer_contact         as customer_contact,
           b.customer_contact_json    as customer_contact_json,
           b.customer_user_id         as customer_user_id,
           b.total_paise              as total_paise,
           lower(b.time_range)        as booking_start_at,
           v.name                     as venue_name,
           ab_fallback.name           as fallback_arena_name
      from bookings b
      left join venues v           on v.id = b.venue_id
      left join arenas ab_fallback on ab_fallback.id = b.slot_arena_id
     where b.id = ${bookingId}
     limit 1
  `);
  const arr = bookingRows as unknown as Record<string, unknown>[];
  const r = arr[0];
  if (!r) return null;

  // Slot-side: aggregate min(start_at) + take any matching arena name.
  const slotRows = await db.execute<Record<string, unknown>>(sql`
    select min(lower(s.time_range)) as slot_start_at,
           max(a.name)               as slot_arena_name
      from slots s
      left join arenas a on a.id = s.arena_id
     where s.booking_id = ${bookingId}
       and s.deleted_at is null
  `);
  const slotArr = slotRows as unknown as Record<string, unknown>[];
  const slotAgg = slotArr[0] ?? {};

  const { phone, email } = extractContacts(
    (r['customer_contact_json'] as Record<string, unknown> | null) ?? null,
    (r['customer_contact'] as string | null) ?? null,
  );

  const totalPaise = Number(r['total_paise'] ?? 0);
  const startAtRaw =
    (slotAgg['slot_start_at'] as string | null) ??
    (r['booking_start_at'] as string | null) ??
    null;
  const startAt = startAtRaw ? new Date(startAtRaw) : null;
  const arenaName =
    (slotAgg['slot_arena_name'] as string | null) ??
    (r['fallback_arena_name'] as string | null) ??
    '';

  return {
    bookingId: r['id'] as string,
    tenantId: r['tenant_id'] as string,
    customerName: (r['customer_name'] as string | null) ?? 'Guest',
    customerUserId: (r['customer_user_id'] as string | null) ?? null,
    phone,
    email,
    venueName: (r['venue_name'] as string | null) ?? 'the venue',
    arenaName,
    startAt,
    totalRupees: (totalPaise / 100).toFixed(2),
    whenText: startAt ? IST_FMT.format(startAt) : 'your booked time',
  };
}

function basePayload(ctx: BookingNotifyContext): Record<string, unknown> {
  return {
    bookingId: ctx.bookingId,
    customerName: ctx.customerName,
    venueName: ctx.venueName,
    arenaName: ctx.arenaName,
    when: ctx.whenText,
    totalRupees: ctx.totalRupees,
  };
}

/** Fan out a single dispatch — swallow errors per-channel so one bad provider
 *  doesn't sink the others. */
async function safeDispatch(input: DispatchInput): Promise<void> {
  try {
    await getNotifications().dispatch(input);
  } catch (err) {
    logger.warn({ err, templateKey: input.templateKey, channel: input.channel }, 'dispatch_failed');
  }
}

function whatsappEnabled(): boolean {
  return Boolean(env.WHATSAPP_PROVIDER && env.WHATSAPP_API_KEY);
}

/** Called from booking confirmation flow. Phase-12/14 services call this after
 *  flipping a booking to `confirmed`. */
export async function notifyBookingConfirmed(bookingId: string): Promise<void> {
  const ctx = await loadBookingContext(bookingId);
  if (!ctx) {
    logger.warn({ bookingId }, 'notify_booking_confirmed_missing');
    return;
  }
  const payload = basePayload(ctx);
  const common = {
    tenantId: ctx.tenantId,
    userId: ctx.customerUserId,
    payload,
  };

  if (ctx.phone) {
    await safeDispatch({
      ...common,
      channel: 'sms' as NotificationChannel,
      recipient: ctx.phone,
      templateKey: 'booking.confirmed',
    });
    if (whatsappEnabled()) {
      await safeDispatch({
        ...common,
        channel: 'whatsapp' as NotificationChannel,
        recipient: ctx.phone,
        templateKey: 'booking.confirmed',
      });
    }
  }
  if (ctx.email) {
    await safeDispatch({
      ...common,
      channel: 'email' as NotificationChannel,
      recipient: ctx.email,
      templateKey: 'booking.confirmed',
    });
  }

  // Schedule reminders if we know when the booking starts and it's in the future.
  if (ctx.startAt && ctx.phone) {
    const now = Date.now();
    const t24 = new Date(ctx.startAt.getTime() - 24 * 60 * 60 * 1000);
    const t1 = new Date(ctx.startAt.getTime() - 60 * 60 * 1000);
    const reminders: Array<{ at: Date; key: 'booking.reminder_t24h' | 'booking.reminder_t1h' }> = [];
    if (t24.getTime() > now) reminders.push({ at: t24, key: 'booking.reminder_t24h' });
    if (t1.getTime() > now) reminders.push({ at: t1, key: 'booking.reminder_t1h' });

    for (const r of reminders) {
      await safeDispatch({
        ...common,
        channel: 'sms' as NotificationChannel,
        recipient: ctx.phone,
        templateKey: r.key,
        scheduledFor: r.at,
      });
      if (whatsappEnabled()) {
        await safeDispatch({
          ...common,
          channel: 'whatsapp' as NotificationChannel,
          recipient: ctx.phone,
          templateKey: r.key,
          scheduledFor: r.at,
        });
      }
    }
  }
}

/** Called from cancellation/refund flow. */
export async function notifyBookingCancelled(bookingId: string): Promise<void> {
  const ctx = await loadBookingContext(bookingId);
  if (!ctx) {
    logger.warn({ bookingId }, 'notify_booking_cancelled_missing');
    return;
  }
  const payload = basePayload(ctx);
  const common = {
    tenantId: ctx.tenantId,
    userId: ctx.customerUserId,
    payload,
  };

  if (ctx.phone) {
    await safeDispatch({
      ...common,
      channel: 'sms' as NotificationChannel,
      recipient: ctx.phone,
      templateKey: 'booking.cancelled',
    });
  }
  if (ctx.email) {
    await safeDispatch({
      ...common,
      channel: 'email' as NotificationChannel,
      recipient: ctx.email,
      templateKey: 'booking.cancelled',
    });
  }
}

