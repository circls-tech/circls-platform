import { randomBytes } from 'node:crypto';
import { type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { BadRequest, Conflict, NotFound } from '../lib/errors.js';
import { ownBookingCondition } from './booking_ownership.js';

/**
 * "Share booking": a customer hands individual QR tickets of an event or court
 * booking to friends, BookMyShow-style. Each shared ticket gets a link; the
 * friend who opens it and accepts sees the booking in their My Bookings with
 * that ticket's QR (and only that one). The customer keeps seeing every
 * ticket, and stays the only one who can cancel. Check-in is unchanged: the
 * venue scans whichever QR is shown.
 *
 * Rules:
 *   - event and court bookings only; memberships are personal;
 *   - the booking must be confirmed and not yet over, the ticket still active;
 *   - one live share per ticket; an accepted share is final, a link nobody has
 *     accepted can be withdrawn;
 *   - the customer can't accept their own link.
 */

export const SHAREABLE_ITEM_TYPES = ['event', 'slot'] as const;

/** A random link token: 24 bytes, base64url (32 characters). */
function newToken(): string {
  return randomBytes(24).toString('base64url');
}

/** Link tokens are base64url; anything else is not one of ours. */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/** First name only: what a friend or the customer is shown of the other. */
export function firstNameOf(displayName: string | null | undefined): string | null {
  const first = displayName?.trim().split(/\s+/)[0];
  return first ? first : null;
}

/**
 * `<alias>` (a bookings row) is shared with `userId`: they accepted one of its
 * tickets. `alias` is a constant from code, never input.
 */
export function sharedWithCondition(userId: string, alias = 'b'): SQL {
  return sql`exists (
    select 1 from booking_ticket_shares s
    where s.booking_id = ${sql.raw(alias)}.id
      and s.claimed_by_user_id = ${userId}::uuid
      and s.withdrawn_at is null)`;
}

/**
 * `<alias>` (a bookings row) hasn't ended: the event's end, or the last booked
 * slot's end, is still ahead.
 */
export function bookingStillOnSql(alias = 'b'): SQL {
  const b = sql.raw(alias);
  return sql`(case ${b}.item_type
    when 'event' then (select e.ends_at from events e where e.id = nullif(${b}.item_data->>'eventId', '')::uuid) > now()
    when 'slot' then (select max(upper(s.time_range)) from slots s where s.booking_id = ${b}.id and s.deleted_at is null) > now()
    else false end)`;
}

/** Whether a booking's tickets can be shared at all (type, status, timing). */
export function canShareBooking(itemType: string, status: string, stillOn: boolean): boolean {
  return (SHAREABLE_ITEM_TYPES as readonly string[]).includes(itemType) && status === 'confirmed' && stillOn;
}

type Row = Record<string, unknown>;
const rowsOf = (r: unknown) => r as Row[];

/**
 * Share one ticket of the caller's own booking: returns the link token. A
 * ticket that already has a link nobody has accepted returns that same link,
 * so "send again" reuses it.
 */
export async function shareTicket(userId: string, bookingId: string, ticketId: string): Promise<{ token: string }> {
  return db.transaction(async (tx) => {
    const found = rowsOf(
      await tx.execute(sql`
        select b.item_type, b.status, ${bookingStillOnSql('b')} as still_on, t.status as ticket_status
        from bookings b
        join qr_tickets t on t.booking_id = b.id and t.id = ${ticketId}::uuid
        where b.id = ${bookingId}::uuid and ${ownBookingCondition(userId)}
        for update of b
      `),
    )[0];
    if (!found) throw new NotFound('Ticket not found', 'ticket_not_found');
    if (!(SHAREABLE_ITEM_TYPES as readonly string[]).includes(found['item_type'] as string)) {
      throw new BadRequest('Only event and court bookings can be shared', 'booking_not_shareable');
    }
    if (!canShareBooking(found['item_type'] as string, found['status'] as string, Boolean(found['still_on']))) {
      throw new Conflict('This booking can no longer be shared', 'booking_not_shareable');
    }
    if (found['ticket_status'] !== 'active') {
      throw new Conflict('This ticket has been used or cancelled', 'ticket_not_active');
    }

    const live = rowsOf(
      await tx.execute(sql`
        select token, claimed_by_user_id from booking_ticket_shares
        where qr_ticket_id = ${ticketId}::uuid and withdrawn_at is null
      `),
    )[0];
    if (live) {
      if (live['claimed_by_user_id']) throw new Conflict('A friend already has this ticket', 'ticket_already_shared');
      return { token: live['token'] as string };
    }

    const token = newToken();
    await tx.execute(sql`
      insert into booking_ticket_shares (booking_id, qr_ticket_id, token, shared_by_user_id)
      values (${bookingId}::uuid, ${ticketId}::uuid, ${token}, ${userId}::uuid)
    `);
    return { token };
  });
}

/** Withdraw a ticket's link before anyone accepts it. An accepted share is final. */
export async function withdrawTicketShare(userId: string, bookingId: string, ticketId: string): Promise<void> {
  const updated = rowsOf(
    await db.execute(sql`
      update booking_ticket_shares s set withdrawn_at = now()
      from bookings b
      where s.booking_id = b.id
        and b.id = ${bookingId}::uuid
        and s.qr_ticket_id = ${ticketId}::uuid
        and s.withdrawn_at is null
        and s.claimed_at is null
        and ${ownBookingCondition(userId)}
      returning s.id
    `),
  );
  if (updated.length > 0) return;
  const accepted = rowsOf(
    await db.execute(sql`
      select 1 from booking_ticket_shares s join bookings b on b.id = s.booking_id
      where b.id = ${bookingId}::uuid and s.qr_ticket_id = ${ticketId}::uuid
        and s.withdrawn_at is null and s.claimed_at is not null
        and ${ownBookingCondition(userId)}
    `),
  );
  if (accepted.length > 0) throw new Conflict('A friend has already accepted this ticket', 'ticket_share_accepted');
  throw new NotFound('No link to withdraw for this ticket', 'ticket_share_not_found');
}

/**
 * Where a share link stands for the person opening it:
 *   available — they can accept it;   yours — they already did;
 *   own — it's their own booking;     taken — someone else accepted it;
 *   withdrawn — the customer took the link back;
 *   inactive — the booking was cancelled or is over, or the ticket was used.
 */
export type TicketShareState = 'available' | 'yours' | 'own' | 'taken' | 'withdrawn' | 'inactive';

export interface TicketSharePreview {
  state: TicketShareState;
  /** The booking, for a link the opener can see it through (yours / own). */
  bookingId: string | null;
  /** The customer's first name. */
  sharedBy: string | null;
  itemType: string;
  /** The event's name, or the venue's for a court booking. */
  title: string;
  /** The venue (for an event at a venue), else null. */
  place: string | null;
  /** The event's start, or the first booked slot's. */
  startsAt: string | null;
  /** IANA zone the booking happens in. */
  timeZone: string;
  /** The ticket's door label ("General · 2 of 3", a court's name). */
  ticketLabel: string | null;
}

async function loadShare(token: string, lock: boolean, tx: Pick<typeof db, 'execute'> = db) {
  return rowsOf(
    await tx.execute(sql`
      select s.id, s.booking_id, s.shared_by_user_id, s.claimed_by_user_id, s.withdrawn_at,
             b.item_type, b.status, ${bookingStillOnSql('b')} as still_on,
             b.customer_user_id, b.created_by_user_id, b.channel, b.created_at as booking_created_at,
             t.status as ticket_status, t.label as ticket_label,
             coalesce(ev.name, v.name, 'Booking') as title,
             case when ev.id is not null then v.name end as place,
             coalesce(ev.starts_at,
                      (select min(lower(sl.time_range)) from slots sl where sl.booking_id = b.id and sl.deleted_at is null)
             ) as starts_at,
             coalesce(v.tz_name, ev.tz_name, 'Asia/Kolkata') as tz_name,
             su.display_name as shared_by_name
      from booking_ticket_shares s
      join bookings b on b.id = s.booking_id
      join qr_tickets t on t.id = s.qr_ticket_id
      left join venues v on v.id = b.venue_id
      left join events ev on ev.id = nullif(b.item_data->>'eventId', '')::uuid
      left join users su on su.id = s.shared_by_user_id
      where s.token = ${token}
      ${lock ? sql`for update of s` : sql``}
    `),
  )[0];
}

function stateFor(r: Row, userId: string): TicketShareState {
  if (r['shared_by_user_id'] === userId || r['customer_user_id'] === userId) return 'own';
  if (r['withdrawn_at']) return 'withdrawn';
  if (r['claimed_by_user_id']) return r['claimed_by_user_id'] === userId ? 'yours' : 'taken';
  if (r['status'] !== 'confirmed' || !r['still_on'] || r['ticket_status'] !== 'active') return 'inactive';
  return 'available';
}

/** What a share link is, for the page that offers to accept it. */
export async function previewTicketShare(userId: string, token: string): Promise<TicketSharePreview> {
  const r = await loadShare(token, false);
  if (!r) throw new NotFound('This link is not valid', 'ticket_share_not_found');
  const state = stateFor(r, userId);
  return {
    state,
    bookingId: state === 'yours' || state === 'own' ? (r['booking_id'] as string) : null,
    sharedBy: firstNameOf(r['shared_by_name'] as string | null),
    itemType: r['item_type'] as string,
    title: r['title'] as string,
    place: (r['place'] as string | null) ?? null,
    startsAt: r['starts_at'] ? new Date(r['starts_at'] as string).toISOString() : null,
    timeZone: r['tz_name'] as string,
    ticketLabel: (r['ticket_label'] as string | null) ?? null,
  };
}

/** Accept a share link: the booking joins the caller's My Bookings with that ticket. */
export async function claimTicketShare(userId: string, token: string): Promise<{ bookingId: string }> {
  return db.transaction(async (tx) => {
    const r = await loadShare(token, true, tx);
    if (!r) throw new NotFound('This link is not valid', 'ticket_share_not_found');
    const bookingId = r['booking_id'] as string;
    switch (stateFor(r, userId)) {
      case 'yours':
        return { bookingId };
      case 'own':
        throw new Conflict('This is your own ticket. Send the link to a friend.', 'own_ticket');
      case 'taken':
        throw new Conflict('Someone else has already added this ticket', 'ticket_share_taken');
      case 'withdrawn':
        throw new Conflict('This link was withdrawn', 'ticket_share_withdrawn');
      case 'inactive':
        throw new Conflict('This booking is no longer active', 'booking_not_shareable');
      case 'available':
        await tx.execute(sql`
          update booking_ticket_shares set claimed_by_user_id = ${userId}::uuid, claimed_at = now()
          where id = ${r['id'] as string}::uuid
        `);
        return { bookingId };
    }
  });
}
