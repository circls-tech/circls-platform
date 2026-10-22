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
 *     - only when phone is present; SMS always, WhatsApp when provider is set
 *   kyc state change:
 *     - tenant owner's email, via tenant_members WHERE role='owner' join users
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { notifications } from '../db/schema/index.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { getNotifications, type DispatchInput } from '../lib/notifications/index.js';
import type { NotificationChannel } from '../lib/notifications/templates.js';
import {
  DEFAULT_TZ,
  formatDayWithYear,
  formatMoney,
  formatWhen,
} from '../lib/notifications/email_format.js';
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

export interface BookingNotifyContext {
  bookingId: string;
  tenantId: string;
  customerName: string;
  customerUserId: string | null;
  phone: string | null;
  email: string | null;
  /** 'slot' | 'event' | 'membership'. */
  itemType: string;
  venueName: string;
  arenaName: string;
  /** When it starts — slots and events only (memberships get no reminders). */
  startAt: Date | null;
  endAt: Date | null;
  /** Time zone the times are shown in: the venue's, else the event's. */
  tz: string;
  currency: string;
  totalPaise: number;
  totalRupees: string;
  eventName: string | null;
  /** Where an event happens: its venue's name, else its own address. */
  eventWhere: string | null;
  /** "2 × General, 1 × VIP". */
  tickets: string | null;
  membershipName: string | null;
  membershipTier: string | null;
  membershipStartsAt: Date | null;
  membershipEndsAt: Date | null;
  whenText: string;
}

/** `item_data->>key` as a uuid, or NULL when it isn't one (never a cast error). */
const itemUuid = (key: string) =>
  sql.raw(
    `(case when b.item_data->>'${key}' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (b.item_data->>'${key}')::uuid end)`,
  );

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
           b.currency                 as currency,
           b.item_type                as item_type,
           lower(b.time_range)        as booking_start_at,
           upper(b.time_range)        as booking_end_at,
           v.name                     as venue_name,
           v.tz_name                  as venue_tz,
           ab_fallback.name           as fallback_arena_name,
           e.name                     as event_name,
           e.starts_at                as event_starts_at,
           coalesce(e.tz_name, ev.tz_name) as event_tz,
           coalesce(ev.name, e.address_json->>'line1', e.address_json->>'city') as event_where,
           m.name                     as membership_name,
           mt.name                    as membership_tier,
           um.starts_at               as membership_starts_at,
           um.ends_at                 as membership_ends_at,
           u.phone_e164               as user_phone,
           u.email                    as user_email,
           u.display_name             as user_display_name,
           u.deleted_at               as user_deleted_at
      from bookings b
      left join venues v           on v.id = b.venue_id
      left join arenas ab_fallback on ab_fallback.id = b.slot_arena_id
      left join events e           on b.item_type = 'event' and e.id = ${itemUuid('eventId')}
      left join venues ev          on ev.id = e.venue_id
      left join memberships m      on b.item_type = 'membership' and m.id = ${itemUuid('membershipId')}
      left join user_memberships um on um.id = ${itemUuid('userMembershipId')}
      left join membership_tiers mt on mt.id = um.membership_tier_id
      left join users u            on u.id = b.customer_user_id
     where b.id = ${bookingId}
     limit 1
  `);
  const arr = bookingRows as unknown as Record<string, unknown>[];
  const r = arr[0];
  if (!r) return null;

  // Slot-side: aggregate min(start_at) + take any matching arena name.
  const slotRows = await db.execute<Record<string, unknown>>(sql`
    select min(lower(s.time_range)) as slot_start_at,
           max(upper(s.time_range)) as slot_end_at,
           max(a.name)               as slot_arena_name
      from slots s
      left join arenas a on a.id = s.arena_id
     where s.booking_id = ${bookingId}
       and s.deleted_at is null
  `);
  const slotArr = slotRows as unknown as Record<string, unknown>[];
  const slotAgg = slotArr[0] ?? {};

  const itemType = (r['item_type'] as string | null) ?? 'slot';
  let tickets: string | null = null;
  if (itemType === 'event') {
    const ticketRows = (await db.execute<Record<string, unknown>>(sql`
      select string_agg(ebt.quantity || ' × ' || tt.name, ', ' order by tt.name) as tickets
        from event_booking_tickets ebt
        join event_ticket_tiers tt on tt.id = ebt.tier_id
       where ebt.booking_id = ${bookingId}
    `)) as unknown as Record<string, unknown>[];
    tickets = (ticketRows[0]?.['tickets'] as string | null) ?? null;
  }

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

  const totalPaise = Number(r['total_paise'] ?? 0);
  const toDate = (v: unknown): Date | null => (v ? new Date(String(v)) : null);
  // Events have no slots: their time is the event's own. Memberships have a
  // validity window, not a start time (and so no reminders).
  const startAt =
    itemType === 'event'
      ? toDate(r['event_starts_at'])
      : itemType === 'membership'
        ? null
        : (toDate(slotAgg['slot_start_at']) ?? toDate(r['booking_start_at']));
  const endAt =
    itemType === 'slot' ? (toDate(slotAgg['slot_end_at']) ?? toDate(r['booking_end_at'])) : null;
  const tz = (r['venue_tz'] as string | null) ?? (r['event_tz'] as string | null) ?? DEFAULT_TZ;
  const membershipStartsAt = toDate(r['membership_starts_at']);
  const membershipEndsAt = toDate(r['membership_ends_at']);
  const arenaName =
    (slotAgg['slot_arena_name'] as string | null) ??
    (r['fallback_arena_name'] as string | null) ??
    '';

  return {
    bookingId: r['id'] as string,
    tenantId: r['tenant_id'] as string,
    customerName:
      (r['customer_name'] as string | null) ??
      (r['user_display_name'] as string | null) ??
      'Guest',
    customerUserId: (r['customer_user_id'] as string | null) ?? null,
    phone: resolvedPhone,
    email: resolvedEmail,
    itemType,
    venueName: (r['venue_name'] as string | null) ?? 'the venue',
    arenaName,
    startAt,
    endAt,
    tz,
    currency: (r['currency'] as string | null) ?? 'INR',
    totalPaise,
    totalRupees: (totalPaise / 100).toFixed(2),
    eventName: (r['event_name'] as string | null) ?? null,
    eventWhere: (r['event_where'] as string | null) ?? null,
    tickets,
    membershipName: (r['membership_name'] as string | null) ?? null,
    membershipTier: (r['membership_tier'] as string | null) ?? null,
    membershipStartsAt,
    membershipEndsAt,
    whenText: startAt
      ? formatWhen(startAt, endAt, tz)
      : membershipStartsAt && membershipEndsAt
        ? `${formatDayWithYear(membershipStartsAt, tz)} – ${formatDayWithYear(membershipEndsAt, tz)}`
        : 'your booked time',
  };
}

/**
 * How a booking reads in a message, whatever was booked:
 *   itemName — one line naming it ("Tan Coffee · Court 1", the event's
 *              name, the membership plan);
 *   details  — its detail lines for the emails, with no empty rows (an event
 *              has no arena, a membership no start time).
 */
export function bookingSummary(ctx: BookingNotifyContext): { itemName: string; details: string; total: string } {
  const total = ctx.totalPaise > 0 ? formatMoney(ctx.totalPaise, ctx.currency) : 'Free';
  const lines: Array<[string, string | null]> = [];
  let itemName: string;
  if (ctx.itemType === 'event') {
    itemName = ctx.eventName ?? 'your event';
    lines.push(
      ['Event', itemName],
      ['Where', ctx.eventWhere],
      ['When', ctx.startAt ? ctx.whenText : 'Date to be announced'],
      ['Tickets', ctx.tickets],
    );
  } else if (ctx.itemType === 'membership') {
    itemName = [ctx.membershipName, ctx.membershipTier].filter(Boolean).join(' · ') || 'your membership';
    // whenText is the validity window for a membership.
    const valid = ctx.membershipStartsAt && ctx.membershipEndsAt ? ctx.whenText : null;
    lines.push(['Plan', itemName], ['Valid', valid]);
  } else {
    itemName = [ctx.venueName, ctx.arenaName].filter(Boolean).join(' · ');
    lines.push(['Venue', ctx.venueName], ['Arena', ctx.arenaName || null], ['When', ctx.whenText]);
  }
  lines.push(['Total', total]);
  const details = lines
    .filter((l): l is [string, string] => Boolean(l[1]))
    .map(([label, value]) => `${label}: ${value}`)
    .join('\n');
  return { itemName, details, total };
}

function basePayload(ctx: BookingNotifyContext): Record<string, unknown> {
  const summary = bookingSummary(ctx);
  return {
    bookingId: ctx.bookingId,
    customerName: ctx.customerName,
    venueName: ctx.venueName,
    arenaName: ctx.arenaName,
    when: ctx.whenText,
    totalRupees: ctx.totalRupees,
    itemName: summary.itemName,
    details: summary.details,
    total: summary.total,
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

  await scheduleReminders(ctx, common);
}

/** Queue the T-24h / T-1h reminders, if we know when the booking starts and
 *  it is still ahead. */
async function scheduleReminders(
  ctx: BookingNotifyContext,
  common: { tenantId: string; userId: string | null; payload: Record<string, unknown> },
): Promise<void> {
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

/**
 * Called after reschedule_service moves a booking's slots. The reminders
 * queued at confirmation point at the old time, so they are dropped and
 * queued again for the new one; the customer gets the new time too.
 */
export async function notifyBookingRescheduled(bookingId: string): Promise<void> {
  const ctx = await loadBookingContext(bookingId);
  if (!ctx) {
    logger.warn({ bookingId }, 'notify_booking_rescheduled_missing');
    return;
  }
  // Reminders still waiting for the old time: skipped, not sent.
  await db
    .update(notifications)
    .set({ status: 'skipped', error: 'booking rescheduled' })
    .where(
      and(
        eq(notifications.status, 'pending'),
        sql`${notifications.templateKey} like 'booking.reminder_%'`,
        sql`${notifications.payload}->>'bookingId' = ${bookingId}`,
      ),
    );

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
      templateKey: 'booking.rescheduled',
    });
    if (whatsappEnabled()) {
      await safeDispatch({
        ...common,
        channel: 'whatsapp' as NotificationChannel,
        recipient: ctx.phone,
        templateKey: 'booking.rescheduled',
      });
    }
  }
  if (ctx.email) {
    await safeDispatch({
      ...common,
      channel: 'email' as NotificationChannel,
      recipient: ctx.email,
      templateKey: 'booking.rescheduled',
    });
  }
  await scheduleReminders(ctx, common);
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

