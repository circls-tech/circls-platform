import { sql, type SQL } from 'drizzle-orm';
import type { membershipStatus } from '../db/schema/memberships.js';
import type { venueStatus } from '../db/schema/venues.js';

type VenueStatus = (typeof venueStatus.enumValues)[number];
type MembershipStatus = (typeof membershipStatus.enumValues)[number];

/**
 * Which venue and membership statuses sit on which admin shelf. 'active' is
 * live or awaiting review; 'closed' is a venue the partner closed and
 * 'inactive' a plan they switched off; 'rejected' is Circls turning it down.
 * Drafts are on none.
 *
 * The admin tenant page's Venues and Memberships tabs show closed (or
 * inactive) and rejected together, as "Closed & rejected"; the Engagement
 * report keeps them apart. Both read these lists, so a status cannot land on
 * one shelf on one page and a different one on the other.
 *
 * Events have no such list: their shelves turn on dates as well as status.
 * The Engagement report's are by lifecycle (admin_engagement.ts); the tenant
 * page's Events tab mirrors the partner's archive instead.
 */
export const VENUE_SHELF_STATUSES = {
  active: ['pending_review', 'active'],
  closed: ['suspended'],
  rejected: ['rejected'],
} as const satisfies Record<string, readonly VenueStatus[]>;

export const MEMBERSHIP_SHELF_STATUSES = {
  active: ['pending_review', 'active'],
  inactive: ['inactive'],
  rejected: ['rejected'],
} as const satisfies Record<string, readonly MembershipStatus[]>;

/**
 * `CASE` naming the shelf a status column is on, per `shelves`; NULL for a
 * status on none (a draft).
 */
export function shelfCaseSql(status: SQL, shelves: Record<string, readonly string[]>): SQL {
  const arms = Object.entries(shelves).map(
    ([shelf, statuses]) =>
      sql`WHEN ${status}::text IN (${sql.join(statuses.map((st) => sql`${st}`), sql`, `)}) THEN ${shelf}::text`,
  );
  return sql`CASE ${sql.join(arms, sql` `)} END`;
}
