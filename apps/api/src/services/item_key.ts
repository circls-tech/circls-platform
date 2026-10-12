import { sql, type SQL } from 'drizzle-orm';

/**
 * The one definition of "which event, plan or venue is this booking's money
 * for?".
 *
 * WHY THIS IS ITS OWN MODULE. Three queries have to agree on this exactly:
 * the partner-facing earnings aggregate, `rawItemAggregates` (which files a
 * payout's money under an item), and `paidOutPayment` (which looks that money
 * back up). They were three copies held together by a comment. A change to one
 * and not the others does not fail a type check, does not fail a test, and
 * does not raise an error — a payment simply looks for a line filed under a
 * different key, reads as unpaid, and a partner is told money has not reached
 * them when it has. Of all the expressions in this codebase, this is the one
 * that most needed to stop being copy-pasted.
 *
 * A slot sale is attributed to its VENUE rather than its arena: a partner
 * thinks in venues, and an arena-level split would not match what the Earnings
 * page shows. `nullif(…, '')` guards an item_data key present but blank, which
 * would otherwise fail the uuid cast rather than reading as unattributed.
 *
 * @param alias Table alias exposing `item_type`, `item_data` and `venue_id` —
 *   a `bookings` row, or a CTE that selected those columns from one.
 */
export function itemKeySql(alias: string): SQL {
  const a = sql.raw(alias);
  return sql`(case ${a}.item_type
                when 'event'      then nullif(${a}.item_data->>'eventId', '')::uuid
                when 'membership' then nullif(${a}.item_data->>'membershipId', '')::uuid
                else ${a}.venue_id
              end)`;
}
