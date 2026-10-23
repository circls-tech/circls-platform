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
import { firstName } from '../lib/notifications/email_format.js';
import {
  basePayload,
  cancelledPayload,
  customerConfirmedPayload,
  isEmail,
  listingApprovedPayload,
  listingRejectedPayload,
  listingSubmittedPayload,
  loadBookingContext,
  loadListingDetail,
  orgSignupPayload,
  partnerBookingPayload,
  refundedPayload,
  type BookingNotifyContext,
  type CancellationMode,
  type ListingNotifyType,
  type RefundReason,
} from './notification_payloads.js';
export type { CancellationMode, ListingNotifyType, RefundReason } from './notification_payloads.js';
import { tenantMembers } from '../db/schema/tenant_members.js';
import { resolveEmailPrefs, tenants, type TenantEmailPrefs } from '../db/schema/tenants.js';
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

// ── Circls admin team ─────────────────────────────────────────────────────────

/**
 * Email every address in ADMIN_TEAM_EMAILS with an `admin.*` template (those go
 * through the internal sender — Resend). A no-op when the list is unset, so a
 * sandbox or a deploy without it writes no rows. One ledger row per recipient,
 * like any other dispatch; failures are per-recipient and never throw.
 */
export async function notifyAdminTeam(
  templateKey: `admin.${string}`,
  payload: Record<string, unknown>,
  tenantId: string | null = null,
): Promise<number> {
  const recipients = env.ADMIN_TEAM_EMAILS;
  for (const recipient of recipients) {
    await safeDispatch({
      tenantId,
      userId: null,
      channel: 'email' as NotificationChannel,
      recipient,
      templateKey,
      payload,
    });
  }
  return recipients.length;
}

// ── Partners (the org that owns the venue / listing) ─────────────────────────

export interface PartnerRecipient {
  email: string;
  /** "Hi …" — the owner's first name, or the org's name for its shared inbox. */
  greetingName: string;
}

/**
 * Which preference (Settings → Notifications) governs a partner email. Keys
 * not listed here are always sent.
 */
export function partnerEmailKind(templateKey: string): keyof TenantEmailPrefs | null {
  if (templateKey === 'partner.booking_confirmed') return 'booking';
  if (templateKey === 'listing.approved' || templateKey === 'listing.rejected') return 'listing';
  return null;
}

/** False when the org switched this kind of email off. */
export async function partnerWantsEmail(tenantId: string, templateKey: string): Promise<boolean> {
  const kind = partnerEmailKind(templateKey);
  if (!kind) return true;
  const [row] = await db
    .select({ emailPrefs: tenants.emailPrefs })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  return resolveEmailPrefs(row?.emailPrefs)[kind];
}

/**
 * Where an org's email goes: its `contact_email` when set (the same address
 * the question alerts use), else the account email of every owner. Deleted
 * accounts are skipped. Empty ⇒ nothing is sent.
 */
export async function partnerRecipients(tenantId: string): Promise<PartnerRecipient[]> {
  const rows = (await db.execute<Record<string, unknown>>(sql`
    select tn.name          as tenant_name,
           tn.contact_email as contact_email,
           u.email          as owner_email,
           u.display_name   as owner_name
      from tenants tn
      left join tenant_members tm on tm.tenant_id = tn.id and tm.role = 'owner'
      left join users u on u.id = tm.user_id and u.deleted_at is null
     where tn.id = ${tenantId}
  `)) as unknown as Record<string, unknown>[];
  const tenantName = (rows[0]?.['tenant_name'] as string | null) ?? 'there';
  const contact = (rows[0]?.['contact_email'] as string | null) ?? null;
  if (contact && isEmail(contact)) return [{ email: contact, greetingName: tenantName }];
  const owners = new Map<string, PartnerRecipient>();
  for (const r of rows) {
    const e = (r['owner_email'] as string | null) ?? null;
    if (e && isEmail(e) && !owners.has(e)) {
      owners.set(e, { email: e, greetingName: firstName(r['owner_name'] as string | null, tenantName) });
    }
  }
  return [...owners.values()];
}

/** Email every partner recipient of a tenant, each greeted by name, unless
 *  the org switched this kind of email off. Returns how many were addressed. */
async function notifyPartner(
  tenantId: string,
  templateKey: string,
  payload: Record<string, unknown> | (() => Promise<Record<string, unknown>>),
): Promise<number> {
  if (!(await partnerWantsEmail(tenantId, templateKey))) return 0;
  const recipients = await partnerRecipients(tenantId);
  if (recipients.length === 0) return 0;
  const body = typeof payload === 'function' ? await payload() : payload;
  for (const r of recipients) {
    await safeDispatch({
      tenantId,
      userId: null,
      channel: 'email' as NotificationChannel,
      recipient: r.email,
      templateKey,
      payload: { ...body, greetingName: r.greetingName },
    });
  }
  return recipients.length;
}

/** Called from booking confirmation flow. Phase-12/14 services call this after
 *  flipping a booking to `confirmed`. Tells the customer (SMS, WhatsApp,
 *  email), the org (email, unless the org entered it at the desk), and queues
 *  the reminders. */
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
      payload: customerConfirmedPayload(ctx),
      channel: 'email' as NotificationChannel,
      recipient: ctx.email,
      templateKey: 'booking.confirmed',
    });
  }
  // Desk (walk-in) bookings are the org's own doing, so those don't echo back.
  if (ctx.channel !== 'walkin') {
    // Built only when it will be sent (it may query the event's capacity).
    await notifyPartner(ctx.tenantId, 'partner.booking_confirmed', () => partnerBookingPayload(ctx));
  }

  await scheduleReminders(ctx, common);
}

/** Queue the T-24h / T-1h reminders, if we know when the booking starts and
 *  it is still ahead. */
async function scheduleReminders(
  ctx: BookingNotifyContext,
  common: { tenantId: string; userId: string | null; payload: Record<string, unknown> },
): Promise<void> {
  if (ctx.startAt && ctx.phone && ctx.itemType !== 'membership') {
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

/** Drop reminders still waiting for a booking that moved or was called off. */
async function skipPendingReminders(bookingId: string, why: string): Promise<void> {
  await db
    .update(notifications)
    .set({ status: 'skipped', error: why })
    .where(
      and(
        eq(notifications.status, 'pending'),
        sql`${notifications.templateKey} like 'booking.reminder_%'`,
        sql`${notifications.payload}->>'bookingId' = ${bookingId}`,
      ),
    );
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
  await skipPendingReminders(bookingId, 'booking rescheduled');

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

export interface BookingCancelledOptions {
  /** Who called it off: the event's organizer (whole event), the customer, or
   *  the venue/org (this booking). Defaults to the venue. */
  mode?: CancellationMode;
  /** Refund issued with the cancellation, minor units. */
  refundPaise?: number;
}

/** Called after a cancellation commits. Tells the customer (SMS + email); the
 *  email says whether money is coming back. */
export async function notifyBookingCancelled(
  bookingId: string,
  opts: BookingCancelledOptions = {},
): Promise<void> {
  const ctx = await loadBookingContext(bookingId);
  if (!ctx) {
    logger.warn({ bookingId }, 'notify_booking_cancelled_missing');
    return;
  }
  await skipPendingReminders(bookingId, 'booking cancelled');
  const common = {
    tenantId: ctx.tenantId,
    userId: ctx.customerUserId,
    payload: basePayload(ctx),
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
      payload: cancelledPayload(ctx, {
        mode: opts.mode ?? 'venue',
        ...(opts.refundPaise !== undefined ? { refundPaise: opts.refundPaise } : {}),
      }),
      channel: 'email' as NotificationChannel,
      recipient: ctx.email,
      templateKey: 'booking.cancelled',
    });
  }
}

/**
 * Called after an event (or an occurrence of a series) is cancelled. Every
 * customer still holding a confirmed booking for it hears about it. The
 * bookings themselves are not cancelled or refunded here — that stays the
 * organizer's call — so the email says the refund comes from them.
 */
export async function notifyEventCancelled(eventId: string): Promise<number> {
  const rows = (await db.execute<Record<string, unknown>>(sql`
    select id from bookings
     where item_type = 'event'
       and status = 'confirmed'
       and item_data->>'eventId' = ${eventId}
  `)) as unknown as Array<{ id: string }>;
  for (const r of rows) {
    await notifyBookingCancelled(r.id, { mode: 'event' });
  }
  return rows.length;
}

export interface BookingRefundedInput {
  amountPaise: number;
  status: 'pending' | 'processed' | 'failed';
  /** The refund's own payments row — shown as the refund reference. */
  refundPaymentId?: string | undefined;
  reason: RefundReason;
}

/**
 * Called after a refund against the booking's charge is recorded. Tells the
 * customer the amount, why, and when to expect it.
 */
export async function notifyBookingRefunded(bookingId: string, refund: BookingRefundedInput): Promise<void> {
  if (refund.status === 'failed') return;
  const ctx = await loadBookingContext(bookingId);
  if (!ctx) {
    logger.warn({ bookingId }, 'notify_booking_refunded_missing');
    return;
  }
  const payload = refundedPayload(ctx, refund);
  const common = { tenantId: ctx.tenantId, userId: ctx.customerUserId, payload };
  if (ctx.phone) {
    await safeDispatch({
      ...common,
      channel: 'sms' as NotificationChannel,
      recipient: ctx.phone,
      templateKey: 'booking.refunded',
    });
  }
  if (ctx.email) {
    await safeDispatch({
      ...common,
      channel: 'email' as NotificationChannel,
      recipient: ctx.email,
      templateKey: 'booking.refunded',
    });
  }
}

// ── Listing review + org sign-up ─────────────────────────────────────────────

/** A listing entered `pending_review` — the admin team has something to do. */
export async function notifyListingSubmitted(type: ListingNotifyType, id: string): Promise<void> {
  if (env.ADMIN_TEAM_EMAILS.length === 0) return;
  const l = await loadListingDetail(type, id);
  if (!l) {
    logger.warn({ type, id }, 'notify_listing_submitted_missing');
    return;
  }
  await notifyAdminTeam('admin.listing_submitted', await listingSubmittedPayload(l), l.tenantId);
}

/** An admin approved or rejected a listing — tell the org. */
export async function notifyListingReviewed(
  type: ListingNotifyType,
  id: string,
  decision: 'approved' | 'rejected',
  reason?: string,
): Promise<void> {
  const l = await loadListingDetail(type, id);
  if (!l) {
    logger.warn({ type, id, decision }, 'notify_listing_reviewed_missing');
    return;
  }
  if (decision === 'approved') {
    await notifyPartner(l.tenantId, 'listing.approved', listingApprovedPayload(l));
  } else {
    await notifyPartner(l.tenantId, 'listing.rejected', listingRejectedPayload(l, reason));
  }
}

/** A partner organisation was created — tell the admin team who signed up. */
export async function notifyOrgCreated(tenantId: string): Promise<void> {
  if (env.ADMIN_TEAM_EMAILS.length === 0) return;
  const payload = await orgSignupPayload(tenantId);
  if (!payload) {
    logger.warn({ tenantId }, 'notify_org_created_missing');
    return;
  }
  await notifyAdminTeam('admin.org_signup', payload, tenantId);
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

