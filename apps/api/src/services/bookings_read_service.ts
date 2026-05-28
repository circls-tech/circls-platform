import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { NotFound } from '../lib/errors.js';
import type { Booking } from '../db/schema/index.js';

/**
 * Read models for the tenant-facing bookings views. Walk-in bookings carry their
 * arena + times on BOTH the slots AND the booking row itself — `bookSlots`
 * persists `slot_arena_id` + `time_range` after the atomic claim. `cancelBooking`
 * nulls `slots.booking_id` (releasing the slots), so for cancelled bookings the
 * slot-side join contributes nothing and the reads MUST fall back to the
 * booking-side columns. Both reads therefore LEFT JOIN bookings→slots (ignoring
 * soft-deleted slots) and LEFT JOIN arenas twice: once via `slots.arena_id`
 * (active) and once via `bookings.slot_arena_id` (the cancelled fallback).
 *
 * Raw `db.execute` is used (mirroring slot_service.listSlots) so the tstzrange
 * lower/upper bounds can be extracted as ISO timestamps in SQL; bigint paise and
 * counts are quantized to JS numbers with Number().
 */

export interface BookingListItem {
  id: string;
  customerName: string | null;
  customerContact: string | null;
  note: string | null;
  status: Booking['status'];
  channel: Booking['channel'];
  totalPaise: number;
  createdAt: string;
  arenaId: string;
  arenaName: string;
  firstStartAt: string;
  lastEndAt: string;
  slotCount: number;
}

export interface ListBookingsFilters {
  fromIso: string;
  toIso: string;
  arenaId?: string;
  status?: Booking['status'];
  q?: string;
}

export async function listBookings(
  tenantId: string,
  venueId: string,
  filters: ListBookingsFilters,
): Promise<BookingListItem[]> {
  const { fromIso, toIso, arenaId, status, q } = filters;

  const window = sql`tstzrange(${fromIso}::timestamptz, ${toIso}::timestamptz, '[)')`;

  // Optional filters folded into the WHERE. The arenaId filter must consult both
  // the slot-side arena (active bookings) AND the booking-side fallback
  // (cancelled bookings, which have no slots). The slot-overlap requirement is
  // enforced per-group via HAVING bool_or — bookings with no remaining slots
  // (cancelled) fall back to the booking's stored time_range for the window match.
  const arenaClause = arenaId
    ? sql` and (s.arena_id = ${arenaId} or b.slot_arena_id = ${arenaId})`
    : sql``;
  const statusClause = status ? sql` and b.status = ${status}` : sql``;
  const qClause = q
    ? sql` and (b.customer_name ilike ${'%' + q + '%'} or b.customer_contact ilike ${'%' + q + '%'})`
    : sql``;

  const rows = await db.execute<Record<string, unknown>>(sql`
    select
      b.id                            as id,
      b.customer_name                 as customer_name,
      b.customer_contact              as customer_contact,
      b.note                          as note,
      b.status                        as status,
      b.channel                       as channel,
      b.total_paise                   as total_paise,
      b.created_at                    as created_at,
      coalesce(min(s.arena_id::text), b.slot_arena_id::text)              as arena_id,
      coalesce(min(a.name), max(a2.name))                                 as arena_name,
      coalesce(min(lower(s.time_range)), lower(b.time_range))             as first_start_at,
      coalesce(max(upper(s.time_range)), upper(b.time_range))             as last_end_at,
      count(s.id)                                                          as slot_count
    from bookings b
    left join slots s on s.booking_id = b.id and s.deleted_at is null
    left join arenas a on a.id = s.arena_id
    left join arenas a2 on a2.id = b.slot_arena_id
    where b.tenant_id = ${tenantId}
      and b.venue_id = ${venueId}${arenaClause}${statusClause}${qClause}
    group by b.id, b.customer_name, b.customer_contact, b.note, b.status, b.channel, b.total_paise, b.created_at, b.slot_arena_id, b.time_range
    having bool_or(s.time_range && ${window})
        or (count(s.id) = 0 and b.time_range && ${window})
    order by coalesce(min(lower(s.time_range)), lower(b.time_range))
  `);

  return (rows as unknown as Record<string, unknown>[]).map((row) => ({
    id: row['id'] as string,
    customerName: (row['customer_name'] as string | null) ?? null,
    customerContact: (row['customer_contact'] as string | null) ?? null,
    note: (row['note'] as string | null) ?? null,
    status: row['status'] as Booking['status'],
    channel: row['channel'] as Booking['channel'],
    totalPaise: Number(row['total_paise']),
    createdAt: new Date(row['created_at'] as string).toISOString(),
    arenaId: row['arena_id'] as string,
    arenaName: row['arena_name'] as string,
    firstStartAt: new Date(row['first_start_at'] as string).toISOString(),
    lastEndAt: new Date(row['last_end_at'] as string).toISOString(),
    slotCount: Number(row['slot_count']),
  }));
}

export interface BookingDetailSlot {
  id: string;
  startAt: string;
  endAt: string;
  pricePaise: number;
  status: string;
}

export interface BookingDetail {
  id: string;
  customerName: string | null;
  customerContact: string | null;
  note: string | null;
  status: Booking['status'];
  channel: Booking['channel'];
  paymentMethod: Booking['paymentMethod'];
  totalPaise: number;
  createdAt: string;
  venueId: string | null;
  arenaId: string | null;
  arenaName: string | null;
  slots: BookingDetailSlot[];
}

export async function getBookingDetail(
  tenantId: string,
  bookingId: string,
): Promise<BookingDetail> {
  // LEFT JOIN against arenas via bookings.slot_arena_id so cancelled bookings
  // (whose slots have been released) can still report their arena.
  const bookingRows = await db.execute<Record<string, unknown>>(sql`
    select b.id                as id,
           b.tenant_id          as tenant_id,
           b.venue_id           as venue_id,
           b.status             as status,
           b.channel            as channel,
           b.payment_method     as payment_method,
           b.customer_name      as customer_name,
           b.customer_contact   as customer_contact,
           b.note               as note,
           b.total_paise        as total_paise,
           b.created_at         as created_at,
           b.slot_arena_id      as booking_arena_id,
           ab.name              as booking_arena_name
      from bookings b
      left join arenas ab on ab.id = b.slot_arena_id
     where b.id = ${bookingId}
     limit 1
  `);
  const bookingArr = bookingRows as unknown as Record<string, unknown>[];
  const booking = bookingArr[0];

  // Tenant-scoped: a booking belonging to another tenant must look like a 404.
  if (!booking || (booking['tenant_id'] as string) !== tenantId) {
    throw new NotFound('Booking not found', 'booking_not_found');
  }

  const slotRows = await db.execute<Record<string, unknown>>(sql`
    select s.id                     as id,
           lower(s.time_range)      as start_at,
           upper(s.time_range)      as end_at,
           s.price_paise            as price_paise,
           s.status                 as status,
           s.arena_id               as arena_id,
           a.name                   as arena_name
    from slots s
    join arenas a on a.id = s.arena_id
    where s.booking_id = ${bookingId}
      and s.deleted_at is null
    order by lower(s.time_range)
  `);
  const slotArr = slotRows as unknown as Record<string, unknown>[];

  const slots: BookingDetailSlot[] = slotArr.map((row) => ({
    id: row['id'] as string,
    startAt: new Date(row['start_at'] as string).toISOString(),
    endAt: new Date(row['end_at'] as string).toISOString(),
    pricePaise: Number(row['price_paise']),
    status: row['status'] as string,
  }));

  // Walk-in slots all share one arena; prefer the slot-side value when present
  // (active bookings), otherwise fall back to the booking-side join (cancelled
  // bookings, whose slots.booking_id has been nulled).
  const arenaId =
    slotArr.length > 0
      ? (slotArr[0]!['arena_id'] as string)
      : ((booking['booking_arena_id'] as string | null) ?? null);
  const arenaName =
    slotArr.length > 0
      ? (slotArr[0]!['arena_name'] as string)
      : ((booking['booking_arena_name'] as string | null) ?? null);

  return {
    id: booking['id'] as string,
    customerName: (booking['customer_name'] as string | null) ?? null,
    customerContact: (booking['customer_contact'] as string | null) ?? null,
    note: (booking['note'] as string | null) ?? null,
    status: booking['status'] as Booking['status'],
    channel: booking['channel'] as Booking['channel'],
    paymentMethod: booking['payment_method'] as Booking['paymentMethod'],
    totalPaise: Number(booking['total_paise']),
    createdAt: new Date(booking['created_at'] as string).toISOString(),
    venueId: (booking['venue_id'] as string | null) ?? null,
    arenaId,
    arenaName,
    slots,
  };
}
