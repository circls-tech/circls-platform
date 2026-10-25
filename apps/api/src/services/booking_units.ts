import { sql, type SQL } from 'drizzle-orm';

/**
 * The one definition of "how many things did this booking sell?".
 *
 * An event booking sells the tickets on it — one booking can hold several, so
 * counting bookings beside ticket money reads as a mismatch (14 bookings
 * holding 15 tickets at ₹120 total ₹1,800, not ₹1,680). A membership or a
 * court booking sells one. An event booking with no ticket lines, sold before
 * ticket tiers existed, counts as one, so this never reads below the booking
 * count.
 *
 * WHY THIS IS ITS OWN MODULE. The partner's Earnings page, the admin payout
 * breakdown and the admin revenue figures all put this count beside money.
 * Like `itemKeySql`, a change made to one copy and not the others fails no
 * type check and no test: the three screens simply start disagreeing about
 * how much an event sold.
 *
 * Callers must apply it once per DISTINCT booking. Summed over payment rows,
 * a booking with two charges (a retried payment) counts its tickets twice.
 *
 * REFUNDS DO NOT REDUCE IT, deliberately — the same as a booking count. A
 * refund here is an amount, never a set of tickets: a cancellation refunds
 * whatever share the cancellation policy allows for the WHOLE booking, and an
 * admin refund is a free-form sum. Nothing records "one ticket of three was
 * refunded", and working it back from the amount would be a guess — a 50%
 * policy refund of three tickets is not one and a half tickets. So this is
 * what was sold; the refund shows up in the money beside it.
 *
 * @param bookingId SQL for the booking's id. ALWAYS table-qualified
 *   (`s.booking_id`, `b.id`): it is read inside a subquery over
 *   event_booking_tickets, which has its own `booking_id` column, so a bare
 *   `booking_id` binds to that one, compares the column with itself, and sums
 *   every ticket in the table.
 * @param itemType  SQL for the booking's `item_type`, qualified likewise.
 */
export function bookingUnitsSql(bookingId: SQL, itemType: SQL): SQL {
  return sql`(case when ${itemType} = 'event'
                   then coalesce((select sum(t.quantity)::int
                                    from event_booking_tickets t
                                   where t.booking_id = ${bookingId}), 1)
                   else 1
              end)`;
}

/**
 * A booking that stands: confirmed, completed or no-show. `cancelled` fell
 * through and `pending` has not happened yet — an abandoned checkout is not a
 * sale. The "Sales" counts dated by when a booking was made (the partner
 * dashboard, the admin dashboard, the admin tenant and partner-user lists, the
 * engagement report) count only these, in {@link bookingUnitsSql} units.
 *
 * @param alias Table alias of a `bookings` row.
 */
export function bookingStandsSql(alias: string): SQL {
  return sql`${sql.raw(alias)}.status in ('confirmed', 'completed', 'no_show')`;
}
