/**
 * Builds the payloads the notification templates render: loads what a booking
 * or listing email shows and formats it display-ready. The designed emails
 * (lib/notifications/email_designs) do no formatting of their own — MSG91
 * renders them with no helpers — so every value here is final text.
 *
 * notification_service.ts decides who gets what; this module only answers
 * "what does it say".
 */
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { env } from '../config/env.js';
import { currencyForCountry } from '../lib/gateway.js';
import {
  DEFAULT_TZ,
  firstName,
  formatAge,
  formatDay,
  formatDayWithYear,
  formatMoney,
  formatWhen,
  noAutoLink,
  plural,
  shortName,
  shortRef,
  toBullets,
  toNumber,
} from '../lib/notifications/email_format.js';

type Row = Record<string, unknown>;
type DetailRow = { label: string; value: string; mono?: boolean };

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = toNumber;
const date = (v: unknown): Date | null => (v ? new Date(String(v)) : null);
const trimSlash = (u: string): string => u.replace(/\/+$/, '');
const consumerUrl = (): string => trimSlash(env.CONSUMER_BASE_URL);
const partnersUrl = (): string => trimSlash(env.PARTNERS_BASE_URL);
const adminUrl = (): string => trimSlash(env.ADMIN_BASE_URL);

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

export { isEmail };

// ── Bookings ─────────────────────────────────────────────────────────────────

export interface BookingNotifyContext {
  bookingId: string;
  bookingRef: string;
  tenantId: string;
  tenantName: string;
  venueId: string | null;
  customerName: string;
  customerUserId: string | null;
  phone: string | null;
  email: string | null;
  venueName: string;
  arenaName: string;
  itemType: string;
  channel: string;
  paymentMethod: string;
  startAt: Date | null;
  endAt: Date | null;
  /** Time zone the booking's times are shown in (venue, else event). */
  tz: string;
  currency: string;
  totalPaise: number;
  eventId: string | null;
  eventName: string | null;
  /** The event itself was called off (its ticket holders were already told). */
  eventCancelled: boolean;
  /** Where an event happens: its venue's name, else its own address. */
  eventWhere: string | null;
  eventCapacity: number | null;
  /** "2 × General, 1 × VIP" for event bookings. */
  tickets: string | null;
  ticketCount: number;
  membershipId: string | null;
  membershipName: string | null;
  membershipTier: string | null;
  membershipStartsAt: Date | null;
  membershipEndsAt: Date | null;
  /** The charge behind this booking, when it was paid for. */
  charge: { provider: string; amountPaise: number; earningsPaise: number | null } | null;
  /** Legacy one-line time for SMS/WhatsApp and the plain-text emails. */
  whenText: string;
}

/**
 * Load a booking and everything its emails show. Returns null if the booking
 * isn't found — callers no-op in that case.
 *
 * Why several queries: the slot-side data (start/end, arena name) is 1:N to
 * the booking when slots haven't been released, and event tickets are 1:N too,
 * so each is aggregated on its own rather than with GROUP BY gymnastics. The
 * fallback arena name comes from the booking's `slot_arena_id` snapshot when
 * slots have been released (cancelled-booking case).
 */
export async function loadBookingContext(bookingId: string): Promise<BookingNotifyContext | null> {
  const rows = (await db.execute<Row>(sql`
    select b.id                       as id,
           b.tenant_id                as tenant_id,
           b.venue_id                 as venue_id,
           b.customer_name            as customer_name,
           b.customer_contact         as customer_contact,
           b.customer_contact_json    as customer_contact_json,
           b.customer_user_id         as customer_user_id,
           b.total_paise              as total_paise,
           b.currency                 as currency,
           b.item_type                as item_type,
           b.channel                  as channel,
           b.payment_method           as payment_method,
           lower(b.time_range)        as booking_start_at,
           upper(b.time_range)        as booking_end_at,
           t.name                     as tenant_name,
           v.name                     as venue_name,
           v.tz_name                  as venue_tz,
           ab_fallback.name           as fallback_arena_name,
           e.id                       as event_id,
           e.name                     as event_name,
           e.status                   as event_status,
           e.starts_at                as event_starts_at,
           e.ends_at                  as event_ends_at,
           e.capacity                 as event_capacity,
           coalesce(e.tz_name, ev.tz_name) as event_tz,
           coalesce(ev.name, e.address_json->>'line1', e.address_json->>'city') as event_where,
           m.id                       as membership_id,
           m.name                     as membership_name,
           mt.name                    as membership_tier,
           um.starts_at               as membership_starts_at,
           um.ends_at                 as membership_ends_at,
           u.phone_e164               as user_phone,
           u.email                    as user_email,
           u.display_name             as user_display_name,
           u.deleted_at               as user_deleted_at
      from bookings b
      left join tenants t          on t.id = b.tenant_id
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
  `)) as unknown as Row[];
  const r = rows[0];
  if (!r) return null;

  // Slot-side: the booked span + any matching arena name.
  const [slotAgg = {}] = (await db.execute<Row>(sql`
    select min(lower(s.time_range)) as slot_start_at,
           max(upper(s.time_range)) as slot_end_at,
           max(a.name)               as slot_arena_name
      from slots s
      left join arenas a on a.id = s.arena_id
     where s.booking_id = ${bookingId}
       and s.deleted_at is null
  `)) as unknown as Row[];

  const itemType = str(r['item_type']) ?? '';
  let tickets: string | null = null;
  let ticketCount = 0;
  if (itemType === 'event') {
    const [t = {}] = (await db.execute<Row>(sql`
      select string_agg(ebt.quantity || ' × ' || tt.name, ', ' order by tt.name) as tickets,
             coalesce(sum(ebt.quantity), 0)::int                               as qty
        from event_booking_tickets ebt
        join event_ticket_tiers tt on tt.id = ebt.tier_id
       where ebt.booking_id = ${bookingId}
    `)) as unknown as Row[];
    tickets = str(t['tickets']);
    ticketCount = num(t['qty']);
  }

  // The charge behind the booking. Called from inside the capture transaction
  // too, where this row may still read `pending` — every snapshot needed here
  // was taken when the order was created, so any non-failed charge will do.
  const [c] = (await db.execute<Row>(sql`
    select provider, amount_paise, settle_base_paise, partner_commission_paise
      from payments
     where booking_id = ${bookingId} and kind = 'charge' and status <> 'failed'
     order by created_at desc
     limit 1
  `)) as unknown as Row[];
  const charge = c
    ? {
        provider: String(c['provider']),
        amountPaise: num(c['amount_paise']),
        // What the org is paid for this sale. Cash at the venue never passes
        // through a payout, so it has no "earnings" in this sense.
        earningsPaise:
          String(c['provider']) === 'external'
            ? null
            : num(c['settle_base_paise'] ?? c['amount_paise']) - num(c['partner_commission_paise']),
      }
    : null;

  const { phone, email } = extractContacts(
    (r['customer_contact_json'] as Record<string, unknown> | null) ?? null,
    str(r['customer_contact']),
  );

  // The booking row usually carries a single contact string (consumer flows
  // send the phone). Fill whichever channel is missing from the customer's own
  // user profile so a confirmation reaches both mobile and email.
  const userPhone = str(r['user_phone']);
  const userEmail = str(r['user_email']);
  // A deleted account must never be contacted again. The users join is already
  // anonymised, but `bookings.customer_contact` is RETAINED as part of the
  // financial record and is preferred above — so without this the venue
  // cancelling an event months later would still text someone who deleted their
  // account. Dropping both channels here is the single chokepoint: every
  // dispatch is guarded by `if (ctx.phone)` / `if (ctx.email)`.
  const accountDeleted = r['user_deleted_at'] != null;
  const resolvedPhone = accountDeleted ? null : (phone ?? (userPhone && isPhone(userPhone) ? userPhone : null));
  const resolvedEmail = accountDeleted ? null : (email ?? (userEmail && isEmail(userEmail) ? userEmail : null));

  const startAt =
    itemType === 'event'
      ? date(r['event_starts_at'])
      : (date(slotAgg['slot_start_at']) ?? date(r['booking_start_at']) ?? date(r['membership_starts_at']));
  const endAt =
    itemType === 'event'
      ? date(r['event_ends_at'])
      : (date(slotAgg['slot_end_at']) ?? date(r['booking_end_at']));
  const tz = str(r['venue_tz']) ?? str(r['event_tz']) ?? DEFAULT_TZ;
  // A membership's time is its validity window, not a start time.
  const membershipStart = date(r['membership_starts_at']);
  const membershipEnd = date(r['membership_ends_at']);
  const membershipWindow =
    itemType === 'membership' && membershipStart && membershipEnd
      ? `${formatDayWithYear(membershipStart, tz)} – ${formatDayWithYear(membershipEnd, tz)}`
      : null;

  return {
    bookingId: String(r['id']),
    bookingRef: shortRef('BK', String(r['id'])),
    tenantId: String(r['tenant_id']),
    tenantName: str(r['tenant_name']) ?? '',
    venueId: str(r['venue_id']),
    customerName: str(r['customer_name']) ?? str(r['user_display_name']) ?? 'Guest',
    customerUserId: str(r['customer_user_id']),
    phone: resolvedPhone,
    email: resolvedEmail,
    venueName: str(r['venue_name']) ?? 'the venue',
    arenaName: str(slotAgg['slot_arena_name']) ?? str(r['fallback_arena_name']) ?? '',
    itemType,
    channel: str(r['channel']) ?? '',
    paymentMethod: str(r['payment_method']) ?? '',
    startAt,
    endAt,
    tz,
    currency: str(r['currency']) ?? 'INR',
    totalPaise: num(r['total_paise']),
    eventId: str(r['event_id']),
    eventName: str(r['event_name']),
    eventCancelled: str(r['event_status']) === 'cancelled',
    eventWhere: str(r['event_where']),
    eventCapacity: r['event_capacity'] == null ? null : num(r['event_capacity']),
    tickets,
    ticketCount,
    membershipId: str(r['membership_id']),
    membershipName: str(r['membership_name']),
    membershipTier: str(r['membership_tier']),
    membershipStartsAt: date(r['membership_starts_at']),
    membershipEndsAt: date(r['membership_ends_at']),
    charge,
    whenText: membershipWindow ?? (startAt ? formatWhen(startAt, itemType === 'slot' ? endAt : null, tz) : 'your booked time'),
  };
}

/**
 * How a booking reads in a plain-text message, whatever was booked:
 *   itemName — one line naming it ("Tan Coffee · Court 1", the event's name,
 *              the membership plan);
 *   details  — its detail lines, with no empty rows (an event has no arena, a
 *              membership no start time).
 */
export function bookingSummary(ctx: BookingNotifyContext): { itemName: string; details: string } {
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
    lines.push(['Plan', itemName], ['Valid', ctx.membershipStartsAt && ctx.membershipEndsAt ? ctx.whenText : null]);
  } else {
    itemName = [ctx.venueName, ctx.arenaName].filter(Boolean).join(' · ');
    lines.push(['Venue', ctx.venueName], ['Arena', ctx.arenaName || null], ['When', ctx.whenText]);
  }
  lines.push(['Total', total]);
  const details = lines
    .filter((l): l is [string, string] => Boolean(l[1]))
    .map(([label, value]) => `${label}: ${value}`)
    .join('\n');
  return { itemName, details };
}

/** The payload the SMS / WhatsApp / plain-text booking templates use. Kept on
 *  every booking notification — `bookingId` is also how reminders are found
 *  again when a booking moves or is cancelled. */
export function basePayload(ctx: BookingNotifyContext): Record<string, unknown> {
  const summary = bookingSummary(ctx);
  return {
    bookingId: ctx.bookingId,
    customerName: ctx.customerName,
    when: ctx.whenText,
    itemName: summary.itemName,
    details: summary.details,
  };
}

const money = (ctx: BookingNotifyContext, minor: number): string => formatMoney(minor, ctx.currency);

/** How a booking reads in an email, whatever was booked. */
interface BookingDisplay {
  /** What the customer booked "at": the venue, the event, the organizer. */
  placeName: string;
  /** "slot" | "spot" | "membership". */
  itemNoun: string;
  /** The big line at the top of the card. */
  heroLabel: string;
  heroValue: string;
  /** "Sat 4 Oct" — for subjects; "Date TBA" when the booking has no date yet
   *  (the designs' subjects always show one). */
  shortDate: string;
  /** "on Sat 4 Oct", or "" when there is no date — for running text. */
  onDate: string;
  /** What-was-booked rows (no reference, no money). */
  itemRows: DetailRow[];
  /** One line naming the item, for partner emails and previews. */
  listingName: string;
}

const NO_DATE = 'Date TBA';

function bookingDisplay(ctx: BookingNotifyContext): BookingDisplay {
  const day = ctx.startAt ? formatDay(ctx.startAt, ctx.tz) : '';
  const dated = (d: string) => ({ shortDate: d || NO_DATE, onDate: d ? `on ${d}` : '' });
  if (ctx.itemType === 'event') {
    const name = ctx.eventName ?? 'your event';
    const rows: DetailRow[] = [{ label: 'Event', value: name }];
    if (ctx.eventWhere) rows.push({ label: 'Where', value: ctx.eventWhere });
    if (ctx.tickets) rows.push({ label: 'Tickets', value: ctx.tickets });
    return {
      placeName: name,
      itemNoun: 'spot',
      heroLabel: 'When',
      heroValue: ctx.startAt ? formatWhen(ctx.startAt, null, ctx.tz) : 'Date to be announced',
      ...dated(day),
      itemRows: rows,
      listingName: name,
    };
  }
  if (ctx.itemType === 'membership') {
    const plan = [ctx.membershipName, ctx.membershipTier].filter(Boolean).join(' · ') || 'Membership';
    const rows: DetailRow[] = [{ label: 'Plan', value: plan }];
    if (ctx.membershipStartsAt) rows.push({ label: 'Starts', value: noAutoLink(formatDayWithYear(ctx.membershipStartsAt, ctx.tz)) });
    return {
      placeName: ctx.tenantName || 'the organizer',
      itemNoun: 'membership',
      heroLabel: 'Valid until',
      heroValue: ctx.membershipEndsAt ? formatDayWithYear(ctx.membershipEndsAt, ctx.tz) : 'See your booking',
      ...dated(ctx.membershipStartsAt ? formatDay(ctx.membershipStartsAt, ctx.tz) : day),
      itemRows: rows,
      listingName: plan,
    };
  }
  const rows: DetailRow[] = [{ label: 'Venue', value: ctx.venueName }];
  if (ctx.arenaName) rows.push({ label: 'Arena', value: ctx.arenaName });
  return {
    placeName: ctx.venueName,
    itemNoun: 'slot',
    heroLabel: 'When',
    heroValue: ctx.whenText,
    ...dated(day),
    itemRows: rows,
    listingName: [ctx.venueName, ctx.arenaName].filter(Boolean).join(' · '),
  };
}

const refRow = (ctx: BookingNotifyContext): DetailRow => ({ label: 'Booking ref', value: ctx.bookingRef, mono: true });
const bookingUrl = (ctx: BookingNotifyContext): string => `${consumerUrl()}/me/bookings/${ctx.bookingId}`;

/** booking.confirmed — to the customer. */
export function customerConfirmedPayload(ctx: BookingNotifyContext): Record<string, unknown> {
  const d = bookingDisplay(ctx);
  return {
    ...basePayload(ctx),
    preheader: [d.itemNoun === 'slot' ? ctx.arenaName : d.placeName, d.heroValue].filter(Boolean).join(' · '),
    firstName: firstName(ctx.customerName),
    itemNoun: d.itemNoun,
    placeName: d.placeName,
    shortDate: d.shortDate,
    heroLabel: d.heroLabel,
    heroValue: noAutoLink(d.heroValue),
    rows: [...d.itemRows, refRow(ctx)],
    totalLabel: 'Total paid',
    totalValue: ctx.totalPaise > 0 ? money(ctx, ctx.totalPaise) : 'Free',
    bookingUrl: bookingUrl(ctx),
  };
}

/** partner.booking_confirmed — to the org. Fetches event capacity on demand. */
export async function partnerBookingPayload(ctx: BookingNotifyContext): Promise<Record<string, unknown>> {
  const d = bookingDisplay(ctx);
  const rows: DetailRow[] = [
    { label: 'Booked by', value: ctx.customerName },
    { label: 'Listing', value: d.listingName },
  ];
  if (ctx.itemType === 'event' && ctx.tickets) rows.push({ label: 'Quantity', value: ctx.tickets });
  if (ctx.itemType === 'membership' && ctx.membershipTier) rows.push({ label: 'Tier', value: ctx.membershipTier });
  rows.push(refRow(ctx), { label: 'Amount paid', value: ctx.totalPaise > 0 ? money(ctx, ctx.totalPaise) : 'Free' });

  let capacity: { filled: number; total: number; pct: number } | undefined;
  if (ctx.itemType === 'event' && ctx.eventId && ctx.eventCapacity && ctx.eventCapacity > 0) {
    const [s = {}] = (await db.execute<Row>(sql`
      select coalesce(sum(ebt.quantity), 0)::int as sold
        from event_booking_tickets ebt
        join bookings b2 on b2.id = ebt.booking_id
       where b2.status <> 'cancelled'
         and b2.item_type = 'event'
         and b2.item_data->>'eventId' = ${ctx.eventId}
    `)) as unknown as Row[];
    const filled = Math.min(num(s['sold']), ctx.eventCapacity);
    capacity = { filled, total: ctx.eventCapacity, pct: Math.round((filled / ctx.eventCapacity) * 100) };
  }

  const earnings =
    ctx.charge?.earningsPaise != null && ctx.charge.earningsPaise > 0 ? money(ctx, ctx.charge.earningsPaise) : undefined;

  let ctaUrl = partnersUrl();
  let ctaLabel = 'Open dashboard';
  if (ctx.itemType === 'event' && ctx.eventId) {
    ctaUrl = `${partnersUrl()}/events/${ctx.eventId}`;
    ctaLabel = 'View registrations';
  } else if (ctx.itemType === 'membership' && ctx.membershipId) {
    ctaUrl = `${partnersUrl()}/memberships/${ctx.membershipId}`;
    ctaLabel = 'View members';
  } else if (ctx.venueId) {
    ctaUrl = `${partnersUrl()}/venues/${ctx.venueId}/bookings`;
    ctaLabel = 'View bookings';
  }

  const preheader = [
    ctx.itemType === 'event' && ctx.ticketCount > 0 ? plural(ctx.ticketCount, 'ticket') : d.heroValue,
    ctx.totalPaise > 0 ? money(ctx, ctx.totalPaise) : 'Free',
    capacity ? `${capacity.filled} of ${capacity.total} spots filled` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return {
    ...basePayload(ctx),
    preheader,
    customerFirst: firstName(ctx.customerName, 'Someone'),
    customerShort: shortName(ctx.customerName),
    listingName: d.listingName,
    heroLabel: d.heroLabel,
    heroValue: noAutoLink(d.heroValue),
    rows,
    ...(capacity ? { capacity } : {}),
    ...(earnings ? { earnings } : {}),
    ctaUrl,
    ctaLabel,
  };
}

/** Who cancelled, for booking.cancelled. */
export type CancellationMode = 'event' | 'customer' | 'venue';

/** booking.cancelled — to the customer. */
export function cancelledPayload(
  ctx: BookingNotifyContext,
  opts: { mode: CancellationMode; refundPaise?: number },
): Record<string, unknown> {
  const d = bookingDisplay(ctx);
  const refundPaise = opts.refundPaise ?? 0;
  const refundText = refundPaise > 0 ? money(ctx, refundPaise) : undefined;
  const paidOnline = ctx.charge != null && ctx.charge.provider !== 'external' && ctx.charge.amountPaise > 0;
  // "Bandra Sports Club has cancelled your booking at Bandra Sports Club" reads
  // badly when the org and the place share a name.
  const orgName =
    ctx.tenantName && ctx.tenantName !== d.placeName
      ? ctx.tenantName
      : ctx.itemType === 'event'
        ? 'The organizer'
        : 'The venue';
  const heroValue =
    ctx.itemType === 'membership' && ctx.membershipStartsAt && ctx.membershipEndsAt
      ? `${formatDay(ctx.membershipStartsAt, ctx.tz)} – ${formatDay(ctx.membershipEndsAt, ctx.tz)}`
      : d.heroValue;

  const preheader = refundText
    ? `${refundText} is on its way back to you.`
    : opts.mode === 'event' && paidOnline
      ? `${[d.placeName, d.onDate].filter(Boolean).join(' ')} is off. We’ll email you about your refund.`
      : `${[d.placeName, d.onDate].filter(Boolean).join(' ')} is cancelled.`;

  return {
    ...basePayload(ctx),
    preheader,
    eventCancelled: opts.mode === 'event',
    byCustomer: opts.mode === 'customer',
    firstName: firstName(ctx.customerName),
    orgName,
    placeName: d.placeName,
    subjectName: d.placeName,
    shortDate: d.shortDate,
    heroValue: noAutoLink(heroValue),
    rows: [...d.itemRows, refRow(ctx)],
    ...(refundText ? { refundText } : {}),
    ...(refundText && ctx.charge?.provider === 'external' ? { refundAtVenue: true } : {}),
    ...(!refundText && opts.mode === 'event' && paidOnline ? { organizerRefundPending: true } : {}),
    browseUrl: `${consumerUrl()}/${ctx.itemType === 'event' ? 'events' : ctx.itemType === 'membership' ? 'memberships' : 'venues'}`,
    bookingUrl: bookingUrl(ctx),
  };
}

/** Why money went back, for booking.refunded. */
export type RefundReason =
  | { kind: 'cancellation'; bySelf: boolean }
  | { kind: 'late_capture' }
  | { kind: 'duplicate' }
  /** Issued from the admin portal: a refund by Circls, not the organiser. */
  | { kind: 'manual' }
  /** The organiser refunding a booking for an event they called off. */
  | { kind: 'event_cancelled' };

/** booking.refunded — to the customer. */
export function refundedPayload(
  ctx: BookingNotifyContext,
  refund: { amountPaise: number; refundPaymentId?: string | undefined; reason: RefundReason },
  now: Date = new Date(),
): Record<string, unknown> {
  const d = bookingDisplay(ctx);
  const amountText = money(ctx, refund.amountPaise);
  const paidPaise = ctx.charge?.amountPaise ?? ctx.totalPaise;
  const paidText = money(ctx, paidPaise);
  const atVenue = ctx.charge?.provider === 'external';
  // Gateways quote 5–7 business days; a week covers it.
  const expectedBy = atVenue ? undefined : formatDay(new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000), ctx.tz);

  const reasonLabel = (() => {
    switch (refund.reason.kind) {
      case 'cancellation':
        return refund.reason.bySelf ? 'Cancelled by you' : `Cancelled by ${ctx.tenantName || 'the venue'}`;
      case 'late_capture':
        return 'Payment arrived after the booking was cancelled';
      case 'duplicate':
        return 'Duplicate payment';
      case 'manual':
        return 'Refund from Circls';
      case 'event_cancelled':
        return `Event cancelled by ${ctx.tenantName || 'the organizer'}`;
    }
  })();

  const rows: DetailRow[] = [
    { label: 'Original booking', value: ctx.bookingRef, mono: true },
    { label: 'Reason', value: reasonLabel },
    { label: 'Refunded to', value: atVenue ? 'Cash at the venue' : 'Original payment method' },
  ];
  if (refund.refundPaymentId) rows.push({ label: 'Refund ref', value: shortRef('RF', refund.refundPaymentId), mono: true });
  rows.push({ label: 'Initiated on', value: noAutoLink(formatDay(now, ctx.tz)) });
  if (expectedBy) rows.push({ label: 'Expected by', value: noAutoLink(expectedBy) });

  const partialNote =
    refund.amountPaise < paidPaise
      ? `You’ve been refunded ${amountText} of the ${paidText} you paid${refund.reason.kind === 'cancellation' ? ', per the cancellation policy' : ''}.`
      : undefined;

  return {
    ...basePayload(ctx),
    amount: amountText,
    preheader: atVenue
      ? `${amountText} to be returned at the venue.`
      : `${amountText} back to your original payment method by ${expectedBy}.`,
    firstName: firstName(ctx.customerName),
    placeName: d.placeName,
    amountText,
    paidText,
    bookingRef: ctx.bookingRef,
    rows,
    ...(partialNote ? { partialNote } : {}),
    ...(expectedBy ? { expectedBy } : {}),
    refundUrl: bookingUrl(ctx),
  };
}

// ── Listings ─────────────────────────────────────────────────────────────────

export type ListingNotifyType = 'venue' | 'arena' | 'event' | 'membership';

const LISTING_PREFIX: Record<ListingNotifyType, string> = { venue: 'VN', arena: 'AR', event: 'EV', membership: 'MB' };
const LISTING_LABEL: Record<ListingNotifyType, string> = {
  venue: 'Venue',
  arena: 'Arena',
  event: 'Event',
  membership: 'Membership',
};

export interface ListingDetail {
  type: ListingNotifyType;
  id: string;
  name: string;
  tenantId: string;
  tenantName: string;
  /** The arena's venue. */
  venueId: string | null;
  venueName: string | null;
  city: string | null;
  currency: string;
  pricePaise: number | null;
  startsAt: Date | null;
  tz: string;
  submittedAt: Date | null;
  submittedBy: string | null;
}

/** Load a listing and what its review emails show. Arenas reach their org
 *  through their venue. */
export async function loadListingDetail(type: ListingNotifyType, id: string): Promise<ListingDetail | null> {
  const select =
    type === 'venue'
      ? sql`select l.name, l.tenant_id, tn.name as tenant_name, null::uuid as venue_id, null::text as venue_name,
                   l.city, coalesce(l.country, tn.country) as country, null::bigint as price_paise,
                   null::timestamptz as starts_at, l.tz_name as tz, l.created_at
              from venues l join tenants tn on tn.id = l.tenant_id where l.id = ${id}`
      : type === 'arena'
        ? sql`select a.name, v.tenant_id, tn.name as tenant_name, v.id as venue_id, v.name as venue_name,
                   v.city, coalesce(v.country, tn.country) as country, null::bigint as price_paise,
                   null::timestamptz as starts_at, v.tz_name as tz, a.created_at
              from arenas a join venues v on v.id = a.venue_id join tenants tn on tn.id = v.tenant_id where a.id = ${id}`
        : type === 'event'
          ? sql`select l.name, l.tenant_id, tn.name as tenant_name, l.venue_id, ev.name as venue_name,
                   coalesce(ev.city, l.address_json->>'city') as city,
                   coalesce(ev.country, l.address_json->>'country', tn.country) as country,
                   l.price_paise, l.starts_at, coalesce(l.tz_name, ev.tz_name) as tz, l.created_at
              from events l join tenants tn on tn.id = l.tenant_id left join venues ev on ev.id = l.venue_id
             where l.id = ${id}`
          : sql`select l.name, l.tenant_id, tn.name as tenant_name, l.venue_id, mv.name as venue_name,
                   coalesce(mv.city, tn.city) as city, coalesce(mv.country, tn.country) as country,
                   l.price_paise, null::timestamptz as starts_at, mv.tz_name as tz, l.created_at
              from memberships l join tenants tn on tn.id = l.tenant_id left join venues mv on mv.id = l.venue_id
             where l.id = ${id}`;
  const [r] = (await db.execute<Row>(sql`${select} limit 1`)) as unknown as Row[];
  if (!r) return null;

  // When it went in for review, and who sent it: the newest audit entry on it
  // with a person behind it (creation, or an event's submission).
  const [a] = (await db.execute<Row>(sql`
    select al.created_at, u.display_name, u.email
      from audit_log al
      left join users u on u.id = al.actor_user_id
     where al.entity_id = ${id}
       and (al.action like '%.submitted_for_review' or al.action like '%.created')
     order by al.created_at desc
     limit 1
  `)) as unknown as Row[];
  const submitter = a
    ? [str(a['display_name']), str(a['email']) ? `(${String(a['email'])})` : null].filter(Boolean).join(' ') || null
    : null;

  return {
    type,
    id,
    name: str(r['name']) ?? `${LISTING_LABEL[type]} ${id}`,
    tenantId: String(r['tenant_id']),
    tenantName: str(r['tenant_name']) ?? '',
    venueId: str(r['venue_id']),
    venueName: str(r['venue_name']),
    city: str(r['city']),
    currency: currencyForCountry(str(r['country'])),
    pricePaise: r['price_paise'] == null ? null : num(r['price_paise']),
    startsAt: date(r['starts_at']),
    tz: str(r['tz']) ?? DEFAULT_TZ,
    submittedAt: date(a?.['created_at']) ?? date(r['created_at']),
    submittedBy: submitter,
  };
}

/** Partner-portal page of a listing. */
function partnerListingUrl(l: ListingDetail): string {
  const path = { venue: 'venues', arena: 'arenas', event: 'events', membership: 'memberships' }[l.type];
  return `${partnersUrl()}/${path}/${l.id}`;
}

/** Customer-site page of a listing (arenas live on their venue's page). */
function consumerListingUrl(l: ListingDetail): string {
  switch (l.type) {
    case 'venue':
      return `${consumerUrl()}/venues/${l.id}`;
    case 'arena':
      return l.venueId ? `${consumerUrl()}/venues/${l.venueId}` : `${consumerUrl()}/venues`;
    case 'event':
      return `${consumerUrl()}/events/${l.id}`;
    case 'membership':
      return `${consumerUrl()}/memberships/${l.id}`;
  }
}

/** "Bandra Sports Club — Turf 2" for an arena, else the listing's name. */
const subjectName = (l: ListingDetail): string =>
  l.type === 'arena' && l.venueName ? `${l.venueName} — ${l.name}` : l.name;

function reviewRows(l: ListingDetail, decidedLabel: string, decidedAt: Date): DetailRow[] {
  const rows: DetailRow[] = [
    { label: 'Type', value: LISTING_LABEL[l.type] },
    { label: 'Organizer', value: l.tenantName },
  ];
  if (l.type === 'arena' && l.venueName) rows.push({ label: 'Venue', value: l.venueName });
  if (l.submittedAt) rows.push({ label: 'Submitted', value: noAutoLink(formatDay(l.submittedAt, l.tz)) });
  rows.push(
    { label: decidedLabel, value: noAutoLink(formatDay(decidedAt, l.tz)) },
    { label: 'Listing ID', value: shortRef(LISTING_PREFIX[l.type], l.id), mono: true },
  );
  return rows;
}

/** listing.approved — to the org (greetingName is filled per recipient). */
export function listingApprovedPayload(l: ListingDetail, now: Date = new Date()): Record<string, unknown> {
  return {
    preheader: `Your ${l.type} passed review and is now bookable.`,
    listingType: l.type,
    listingName: l.name,
    subjectName: subjectName(l),
    rows: reviewRows(l, 'Approved', now),
    liveUrl: consumerListingUrl(l),
    portalUrl: partnerListingUrl(l),
  };
}

/** listing.rejected — to the org. The partner fixes the listing in place and
 *  presses Submit again on its page, which sends it back to review. */
export function listingRejectedPayload(
  l: ListingDetail,
  reason: string | undefined,
  now: Date = new Date(),
): Record<string, unknown> {
  const fixes = toBullets(reason);
  // The listing's own page carries the reason, Edit and Submit again (an
  // arena's is its reception page, with the "Fix this arena" card).
  const ctaUrl = partnerListingUrl(l);
  const ctaLabel = 'Edit & resubmit';
  const nextStep = 'Make the fixes on the listing and press Submit again — it’s usually reviewed within 24 hours.';
  const preheader =
    fixes.length > 0
      ? `${fixes.length === 1 ? 'One quick fix' : `${fixes.length} quick fixes`} and your ${l.type} can go live.`
      : `A few changes and your ${l.type} can go live.`;
  return {
    preheader,
    listingType: l.type,
    listingName: l.name,
    subjectName: subjectName(l),
    rows: reviewRows(l, 'Reviewed', now),
    fixes,
    reason: reason?.trim() ?? '',
    ctaUrl,
    ctaLabel,
    nextStep,
    portalUrl: partnerListingUrl(l),
  };
}

/** admin.listing_submitted — to the admin team, with the review queue's size. */
export async function listingSubmittedPayload(l: ListingDetail, now: Date = new Date()): Promise<Record<string, unknown>> {
  const [q = {}] = (await db.execute<Row>(sql`
    select count(*)::int as n, min(created_at) as oldest from (
      select created_at from venues      where status = 'pending_review'
      union all select created_at from arenas      where status = 'pending_review'
      union all select created_at from events      where status = 'pending_review'
      union all select created_at from memberships where status = 'pending_review'
    ) q
  `)) as unknown as Row[];
  const queueCount = Math.max(1, num(q['n']));
  const oldest = date(q['oldest']) ?? l.submittedAt ?? now;

  const price =
    l.pricePaise != null && l.pricePaise > 0
      ? l.type === 'event'
        ? `${formatMoney(l.pricePaise, l.currency)} / ticket`
        : `from ${formatMoney(l.pricePaise, l.currency)}`
      : l.type === 'event' && l.pricePaise === 0
        ? 'Free'
        : null;

  const rows: DetailRow[] = [
    { label: 'Type', value: LISTING_LABEL[l.type] },
    { label: 'Organizer', value: l.tenantName },
  ];
  if (l.type === 'arena' && l.venueName) rows.push({ label: 'Venue', value: l.venueName });
  if (l.submittedBy) rows.push({ label: 'Submitted by', value: l.submittedBy });
  if (l.city) rows.push({ label: 'City', value: l.city });
  if (price) rows.push({ label: 'Price', value: price });
  if (l.startsAt) rows.push({ label: 'Starts', value: noAutoLink(formatWhen(l.startsAt, null, l.tz)) });
  rows.push({ label: 'Listing ID', value: shortRef(LISTING_PREFIX[l.type], l.id), mono: true });

  return {
    preheader: [l.city, price, `${queueCount} in queue`].filter(Boolean).join(' · '),
    tenantName: l.tenantName,
    listingType: l.type,
    listingTypeLabel: LISTING_LABEL[l.type],
    listingName: subjectName(l),
    rows,
    reviewUrl: `${adminUrl()}/listings?type=${l.type}`,
    queueCount,
    queueOne: queueCount === 1,
    oldestAge: formatAge(now.getTime() - oldest.getTime()),
  };
}

// ── Organisations ────────────────────────────────────────────────────────────

/** admin.org_signup — to the admin team. Null when the org is gone. */
export async function orgSignupPayload(tenantId: string, now: Date = new Date()): Promise<Record<string, unknown> | null> {
  const [r] = (await db.execute<Row>(sql`
    select tn.name, tn.city, tn.country, tn.contact_phone, tn.contact_email,
           u.display_name as owner_name, u.email as owner_email, u.phone_e164 as owner_phone
      from tenants tn
      left join tenant_members tm on tm.tenant_id = tn.id and tm.role = 'owner'
      left join users u on u.id = tm.user_id
     where tn.id = ${tenantId}
     order by tm.created_at asc nulls last
     limit 1
  `)) as unknown as Row[];
  if (!r) return null;
  const [w = {}] = (await db.execute<Row>(sql`
    select count(*)::int as n from tenants
     where is_platform = false and created_at >= ${new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()}::timestamptz
  `)) as unknown as Row[];
  const weekCount = Math.max(1, num(w['n']));

  const name = str(r['name']) ?? 'A new organizer';
  const city = str(r['city']);
  const ownerName = str(r['owner_name']);
  const rows: DetailRow[] = [];
  if (city) rows.push({ label: 'City', value: city });
  if (str(r['country'])) rows.push({ label: 'Country', value: String(r['country']) });
  if (ownerName) rows.push({ label: 'Contact', value: ownerName });
  const email = str(r['owner_email']) ?? str(r['contact_email']);
  if (email) rows.push({ label: 'Email', value: email });
  const phone = str(r['contact_phone']) ?? str(r['owner_phone']);
  if (phone) rows.push({ label: 'Phone', value: phone });
  rows.push({ label: 'Org ID', value: shortRef('ORG', tenantId), mono: true });

  return {
    preheader: [city, ownerName ? `Owner ${ownerName}` : null].filter(Boolean).join(' · ') || 'New partner sign-up',
    tenantName: name,
    ...(city ? { city } : {}),
    rows,
    weekCount,
    weekOne: weekCount === 1,
    orgUrl: `${adminUrl()}/tenants/${tenantId}`,
  };
}
