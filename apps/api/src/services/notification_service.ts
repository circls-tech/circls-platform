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
 *     - if both phone + email present → fan out to both, plus WhatsApp when
 *       phone is present AND a WA provider is configured
 *     - contact sources, in priority order: customer_contact_json (structured),
 *       the legacy customer_contact string, then the booking customer's own
 *       user profile (users.phone_e164 / users.email via customer_user_id) —
 *       consumer bookings only store a phone, so the profile is what lets the
 *       confirmation reach both mobile and email
 *   booking reminders (T-24h, T-1h):
 *     - slot bookings only, and only when phone is present; SMS always,
 *       WhatsApp when provider is set
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
  /** bookings.item_type ('slot' | 'event' | 'membership'); picks the copy. */
  itemType: string;
  customerName: string;
  customerUserId: string | null;
  phone: string | null;
  email: string | null;
  /** The venue, or the organiser when an event or membership has no venue. */
  venueName: string;
  /** Slot bookings only; '' when unknown. */
  arenaName: string;
  eventTitle: string | null;
  membershipName: string | null;
  /** When the booked slot or event starts. */
  startAt: Date | null;
  whenText: string;
  /** Membership bookings: the day the membership runs out. */
  validUntilText: string | null;
  /** The total with its currency ("Rs 500.00", "$25.00"); null = state none. */
  totalText: string | null;
}

/** Venue timezone default (venues.tz_name's column default). */
const DEFAULT_TZ = 'Asia/Kolkata';

/** en-IN shapes: "04 Jul 2026, 18:00" and "04 Jul 2026". */
const WHEN_FORMAT: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
};
const DATE_FORMAT: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: '2-digit' };

/**
 * Format `d` in the booking's local timezone. tz_name is free text, so a zone
 * Intl doesn't know falls back to IST instead of throwing: this runs inside
 * the payment-capture transaction, and a throw there rolls back the capture.
 */
function formatInZone(d: Date, tz: string, format: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat('en-IN', { ...format, timeZone: tz }).format(d);
  } catch {
    return new Intl.DateTimeFormat('en-IN', { ...format, timeZone: DEFAULT_TZ }).format(d);
  }
}

/**
 * A booking total with its currency: "Rs 500.00" for INR, as these messages
 * have always put it, and "$25.00" for USD. The *_paise columns hold minor
 * units of the booking's own currency, so a USD booking's are cents.
 */
function formatTotal(minor: number, currency: string): string {
  const amount = (minor / 100).toFixed(2);
  const code = currency.toUpperCase();
  if (code === 'INR') return `Rs ${amount}`;
  if (code === 'USD') return `$${amount}`;
  return `${code} ${amount}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A uuid from bookings.item_data, or null. A malformed id must never reach a
 *  uuid comparison, where it would throw. */
function itemDataId(itemData: Record<string, unknown>, key: string): string | null {
  const v = itemData[key];
  return typeof v === 'string' && UUID_RE.test(v) ? v : null;
}

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
 * A slot booking's start and arena.
 *
 * Why a separate query: the slot-side data (start_at, arena name) is 1:N to
 * the booking when slots haven't been released, so we aggregate separately to
 * avoid GROUP BY gymnastics. Once slots have been released (cancelled-booking
 * case), the booking's own `time_range` and `slot_arena_id` snapshots stand in.
 */
async function loadBookedSlots(
  bookingId: string,
  booking: Record<string, unknown>,
): Promise<{ startAt: Date | null; arenaName: string }> {
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

  const startAtRaw =
    (slotAgg['slot_start_at'] as string | null) ??
    (booking['booking_start_at'] as string | null) ??
    null;
  return {
    startAt: startAtRaw ? new Date(startAtRaw) : null,
    arenaName:
      (slotAgg['slot_arena_name'] as string | null) ??
      (booking['fallback_arena_name'] as string | null) ??
      '',
  };
}

/**
 * An event booking's event (`bookings.item_data.eventId`): its title, its
 * start, and where it takes place now. The location follows the event, not
 * the booking's `venue_id` snapshot, because a partner can re-scope an event
 * after it has sold tickets. A venue-less (standalone) event carries its own
 * timezone. This mirrors the consumer event payload (consumer_service's
 * `toPublicEvent`).
 */
async function loadBookedEvent(
  itemData: Record<string, unknown>,
  tenantId: string,
): Promise<{ title: string; startsAt: Date; venueName: string | null; tz: string | null } | null> {
  const eventId = itemDataId(itemData, 'eventId');
  if (!eventId) return null;
  const rows = await db.execute<Record<string, unknown>>(sql`
    select e.name      as name,
           e.starts_at as starts_at,
           e.venue_id  as venue_id,
           e.tz_name   as tz_name,
           v.name      as venue_name,
           v.tz_name   as venue_tz_name
      from events e
      left join venues v on v.id = e.venue_id
     where e.id = ${eventId}
       and e.tenant_id = ${tenantId}
     limit 1
  `);
  const e = (rows as unknown as Record<string, unknown>[])[0];
  if (!e) return null;
  const standalone = e['venue_id'] == null;
  return {
    title: e['name'] as string,
    startsAt: new Date(e['starts_at'] as string),
    venueName: (e['venue_name'] as string | null) ?? null,
    tz: ((standalone ? e['tz_name'] : e['venue_tz_name']) as string | null) ?? null,
  };
}

/**
 * A membership booking's plan (`bookings.item_data.membershipId`) and where it
 * is held. When the booking also carries its user_membership (`item_data.
 * userMembershipId`, stamped at purchase), this includes when it runs out.
 */
async function loadBookedMembership(
  itemData: Record<string, unknown>,
  tenantId: string,
): Promise<{ name: string; venueName: string | null; tz: string | null; endsAt: Date | null } | null> {
  const membershipId = itemDataId(itemData, 'membershipId');
  if (!membershipId) return null;
  const userMembershipId = itemDataId(itemData, 'userMembershipId');
  const rows = await db.execute<Record<string, unknown>>(sql`
    select m.name     as name,
           v.name     as venue_name,
           v.tz_name  as venue_tz_name,
           um.ends_at as ends_at
      from memberships m
      left join venues v on v.id = m.venue_id
      left join user_memberships um
             on um.id = ${userMembershipId}
            and um.membership_id = m.id
     where m.id = ${membershipId}
       and m.tenant_id = ${tenantId}
     limit 1
  `);
  const m = (rows as unknown as Record<string, unknown>[])[0];
  if (!m) return null;
  return {
    name: m['name'] as string,
    venueName: (m['venue_name'] as string | null) ?? null,
    tz: (m['venue_tz_name'] as string | null) ?? null,
    endsAt: m['ends_at'] ? new Date(m['ends_at'] as string) : null,
  };
}

/**
 * Load a booking, what it is for (slots, an event or a membership), and the
 * customer's contacts for a notification. Returns null if the booking isn't
 * found — callers no-op in that case.
 */
async function loadBookingContext(bookingId: string): Promise<BookingNotifyContext | null> {
  const bookingRows = await db.execute<Record<string, unknown>>(sql`
    select b.id                       as id,
           b.tenant_id                as tenant_id,
           b.item_type                as item_type,
           b.item_data                as item_data,
           b.payment_method           as payment_method,
           b.customer_name            as customer_name,
           b.customer_contact         as customer_contact,
           b.customer_contact_json    as customer_contact_json,
           b.customer_user_id         as customer_user_id,
           b.total_paise              as total_paise,
           b.currency                 as currency,
           lower(b.time_range)        as booking_start_at,
           v.name                     as venue_name,
           v.tz_name                  as venue_tz_name,
           tn.name                    as tenant_name,
           ab_fallback.name           as fallback_arena_name,
           u.phone_e164               as user_phone,
           u.email                    as user_email,
           u.display_name             as user_display_name,
           u.deleted_at               as user_deleted_at
      from bookings b
      left join venues v           on v.id = b.venue_id
      left join tenants tn         on tn.id = b.tenant_id
      left join arenas ab_fallback on ab_fallback.id = b.slot_arena_id
      left join users u            on u.id = b.customer_user_id
     where b.id = ${bookingId}
     limit 1
  `);
  const arr = bookingRows as unknown as Record<string, unknown>[];
  const r = arr[0];
  if (!r) return null;

  const { phone, email } = extractContacts(
    (r['customer_contact_json'] as Record<string, unknown> | null) ?? null,
    (r['customer_contact'] as string | null) ?? null,
  );

  // The booking row usually carries a single contact string (consumer flows
  // send the phone). Fill whichever channel is missing from the customer's own
  // user profile so a confirmation reaches both mobile and email.
  const userPhone = (r['user_phone'] as string | null) ?? null;
  const userEmail = (r['user_email'] as string | null) ?? null;
  // A deleted account must never be contacted again. The users join is already
  // anonymised, but `bookings.customer_contact` is RETAINED as part of the
  // financial record and is preferred above — so without this the venue
  // cancelling an event months later would still text someone who deleted their
  // account. Dropping both channels here is the single chokepoint: every
  // dispatch below is guarded by `if (ctx.phone)` / `if (ctx.email)`.
  const accountDeleted = r['user_deleted_at'] != null;
  const resolvedPhone = accountDeleted
    ? null
    : (phone ?? (userPhone && isPhone(userPhone) ? userPhone : null));
  const resolvedEmail = accountDeleted
    ? null
    : (email ?? (userEmail && isEmail(userEmail) ? userEmail : null));

  // What the booking is for. Each item type knows its own place and time;
  // until one says otherwise, that is the booking's venue and no start time.
  const tenantId = r['tenant_id'] as string;
  const itemType = r['item_type'] as string;
  const itemData = (r['item_data'] as Record<string, unknown> | null) ?? {};
  let venueName = (r['venue_name'] as string | null) ?? null;
  let tz = (r['venue_tz_name'] as string | null) ?? null;
  let startAt: Date | null = null;
  let arenaName = '';
  let eventTitle: string | null = null;
  let membershipName: string | null = null;
  let validUntil: Date | null = null;

  if (itemType === 'event') {
    const ev = await loadBookedEvent(itemData, tenantId);
    if (ev) {
      venueName = ev.venueName;
      tz = ev.tz;
      startAt = ev.startsAt;
    }
    // Should the event not load, the title snapshotted at booking time.
    const snapshot = itemData['eventName'];
    eventTitle = ev?.title ?? (typeof snapshot === 'string' && snapshot ? snapshot : 'your event');
  } else if (itemType === 'membership') {
    const m = await loadBookedMembership(itemData, tenantId);
    if (m) {
      venueName = m.venueName;
      tz = m.tz;
      membershipName = m.name;
      validUntil = m.endsAt;
    }
  } else {
    const booked = await loadBookedSlots(bookingId, r);
    startAt = booked.startAt;
    arenaName = booked.arenaName;
  }

  const zone = tz ?? DEFAULT_TZ;
  const totalPaise = Number(r['total_paise'] ?? 0);
  // A registration the partner recorded (payment_method 'external') stores a
  // zero total because Circls took no money. The attendee may still have paid
  // the partner, so rather than claim "Rs 0.00" the copy states no total.
  const statesTotal = !(r['payment_method'] === 'external' && totalPaise === 0);

  return {
    bookingId: r['id'] as string,
    tenantId,
    itemType,
    customerName:
      (r['customer_name'] as string | null) ??
      (r['user_display_name'] as string | null) ??
      'Guest',
    customerUserId: (r['customer_user_id'] as string | null) ?? null,
    phone: resolvedPhone,
    email: resolvedEmail,
    // A venue-less event or org-wide membership is named for its organiser,
    // as the consumer app does.
    venueName: venueName ?? (r['tenant_name'] as string | null) ?? 'the venue',
    arenaName,
    eventTitle,
    membershipName,
    startAt,
    whenText: startAt ? formatInZone(startAt, zone, WHEN_FORMAT) : 'your booked time',
    validUntilText: validUntil ? formatInZone(validUntil, zone, DATE_FORMAT) : null,
    totalText: statesTotal ? formatTotal(totalPaise, (r['currency'] as string | null) ?? 'INR') : null,
  };
}

/** The template payload. `itemType` picks the event/membership copy; null
 *  fields drop out of the sections that use them. */
function basePayload(ctx: BookingNotifyContext): Record<string, unknown> {
  return {
    bookingId: ctx.bookingId,
    itemType: ctx.itemType,
    customerName: ctx.customerName,
    venueName: ctx.venueName,
    arenaName: ctx.arenaName,
    eventTitle: ctx.eventTitle,
    membershipName: ctx.membershipName,
    when: ctx.whenText,
    validUntil: ctx.validUntilText,
    total: ctx.totalText,
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
  // Slot bookings only: a queued reminder isn't withdrawn when its booking is
  // cancelled or moved, and cancelEvent leaves an event's bookings confirmed,
  // so an event reminder could still go out for an event that is off.
  if (ctx.itemType === 'slot' && ctx.startAt && ctx.phone) {
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

// ── Questions threads (design doc 2026-07-18) ────────────────────────────────

const QUESTION_EXCERPT_LEN = 280;

/**
 * Email the owning org about a brand-new question thread. Recipient is the
 * tenant's `contact_email` — silently skipped when unset. Called via the
 * best-effort `onQuestionAsked` hook (never throws through to the write path).
 */
export async function notifyQuestionAsked(threadId: string): Promise<void> {
  const res = await db.execute<Record<string, unknown>>(sql`
    select t.tenant_id                        as tenant_id,
           t.visibility                       as visibility,
           tn.contact_email                   as contact_email,
           coalesce(e.name, a.name, m.name)   as subject_name,
           root.body                          as root_body
      from question_threads t
      join tenants tn on tn.id = t.tenant_id
      left join events e on e.id = t.event_id
      left join arenas a on a.id = t.arena_id
      left join memberships m on m.id = t.membership_id
      join lateral (
        select qm.body from question_messages qm
         where qm.thread_id = t.id
         order by qm.created_at asc, qm.id asc limit 1
      ) root on true
     where t.id = ${threadId}
     limit 1
  `);
  const arr = res as unknown as Record<string, unknown>[];
  const r = arr[0];
  if (!r) {
    logger.warn({ threadId }, 'notify_question_asked_missing');
    return;
  }
  const contactEmail = (r['contact_email'] as string | null) ?? null;
  if (!contactEmail || !isEmail(contactEmail)) return;

  await safeDispatch({
    tenantId: r['tenant_id'] as string,
    userId: null,
    channel: 'email' as NotificationChannel,
    recipient: contactEmail,
    templateKey: 'question.asked',
    payload: {
      subjectName: (r['subject_name'] as string | null) ?? 'your listing',
      excerpt: String(r['root_body'] ?? '').slice(0, QUESTION_EXCERPT_LEN),
      visibility: r['visibility'] as string,
      portalUrl: `${env.PARTNERS_BASE_URL}/questions/${threadId}`,
    },
  });
}

/**
 * Email the thread author when the org or the Circls team replies. Recipient
 * is the author's `users.email` — silently skipped when unset. Consumer
 * replies on public threads never email anyone (spec §4).
 */
export async function notifyQuestionReplied(threadId: string, messageId: string): Promise<void> {
  const res = await db.execute<Record<string, unknown>>(sql`
    select t.tenant_id                        as tenant_id,
           t.author_user_id                   as author_user_id,
           au.email                           as author_email,
           tn.name                            as tenant_name,
           coalesce(e.name, a.name, m.name)   as subject_name,
           qm.body                            as reply_body,
           qm.author_kind                     as reply_author_kind
      from question_threads t
      join tenants tn on tn.id = t.tenant_id
      join users au on au.id = t.author_user_id
      left join events e on e.id = t.event_id
      left join arenas a on a.id = t.arena_id
      left join memberships m on m.id = t.membership_id
      join question_messages qm on qm.id = ${messageId} and qm.thread_id = t.id
     where t.id = ${threadId}
     limit 1
  `);
  const arr = res as unknown as Record<string, unknown>[];
  const r = arr[0];
  if (!r) {
    logger.warn({ threadId, messageId }, 'notify_question_replied_missing');
    return;
  }
  const authorEmail = (r['author_email'] as string | null) ?? null;
  if (!authorEmail || !isEmail(authorEmail)) return;

  const kind = r['reply_author_kind'] as string;
  await safeDispatch({
    tenantId: r['tenant_id'] as string,
    userId: r['author_user_id'] as string,
    channel: 'email' as NotificationChannel,
    recipient: authorEmail,
    templateKey: 'question.replied',
    payload: {
      subjectName: (r['subject_name'] as string | null) ?? 'a listing',
      excerpt: String(r['reply_body'] ?? '').slice(0, QUESTION_EXCERPT_LEN),
      authorName: kind === 'circls' ? 'The Circls team' : ((r['tenant_name'] as string | null) ?? 'The organizer'),
      link: `${env.CONSUMER_BASE_URL}/me/questions`,
    },
  });
}

