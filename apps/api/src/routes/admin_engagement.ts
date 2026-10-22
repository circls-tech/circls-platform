import type { FastifyPluginAsync } from 'fastify';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { BadRequest } from '../lib/errors.js';
import { csvDocument } from '../lib/csv.js';
import { getPlatformTenantId } from '../lib/authz/platform_tenant.js';
import { assertCap } from '../middleware/require_cap.js';
import { requireAuth } from '../middleware/require_auth.js';
import { currentUser } from '../middleware/current_user.js';
import { requireTenantMembership } from '../middleware/tenant_context.js';
import { isShareSql, isViewSql } from '../services/engagement_signals.js';
import { itemKeySql } from '../services/item_key.js';

/**
 * Platform-admin Engagement report, GET /v1/admin/engagement: one row per
 * event, venue or membership plan with how consumers engaged with it.
 *
 * Counts only, never who, so it needs admin.tenants.read (Owner, Manager and
 * Staff) rather than admin.users.read. Who liked and shared what is on the
 * consumer report, behind the stronger cap.
 *
 * What each column counts (views and shares are defined in
 * engagement_signals.ts, shared with the consumer report):
 *   - views / viewers: listing views from both clients, and the distinct
 *     signed-in people behind them.
 *   - likes: people who have the listing on their wishlist now.
 *   - shares: share taps that sent or copied the link.
 *   - bookings: bookings made in the consumer app (channel 'circls') that went
 *     through (confirmed, completed or no-show): the end of the funnel that
 *     starts with a view. A court booking counts against its venue.
 *
 * A RECURRING EVENT IS ONE ROW. Every date of a series is its own events row,
 * and the consumer site shows the series as one card linking to whichever date
 * is next, so its views, likes and shares land on different dates over time.
 * The dates are counted together (viewers and likes by distinct person) under
 * the date that stands for the series: the next live one, else the latest.
 * `dates` says how many there are; `seriesId` is null for a one-off.
 *
 * `since` narrows every count to what happened at or after it (a like counts
 * from when it was made). Drafts are left out: nobody outside the partner
 * could see them. The name filter is applied before anything is counted, so
 * a search only aggregates the listings it matched. Rows are ordered by
 * views, then likes, shares, bookings and name; the order is computed, so
 * `cursor` is simply the offset of the next page. Every row also carries the
 * totals across all matching listings, for the summary tiles. `format=csv`
 * returns every matching row, capped at CSV_MAX_ROWS.
 */

const CSV_MAX_ROWS = 10_000;

const ENGAGEMENT_TYPES = ['event', 'venue', 'membership'] as const;
type EngagementType = (typeof ENGAGEMENT_TYPES)[number];

const querySchema = z.object({
  type: z.enum(ENGAGEMENT_TYPES).optional(),
  /** Listing or organiser name. */
  q: z.string().min(1).max(200).optional(),
  /** Count only activity at/after this instant. */
  since: z.string().datetime({ offset: true }).optional(),
  cursor: z.string().regex(/^\d{1,9}$/).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  format: z.enum(['json', 'csv']).optional(),
});

/**
 * Every non-draft listing of a type, with the group it is counted under
 * (`grp`), whether it stands for that group (`pick = 1`) and how many listings
 * the group has. Only events group: by series, with the date that stands for
 * it ordered live before cancelled, upcoming before past, then nearest to now.
 * An event's time zone is its own (standalone events) or its venue's.
 */
const LISTINGS: Record<EngagementType, SQL> = {
  event: sql`
    SELECT e.id AS item_id, coalesce(e.series_id, e.id) AS grp, e.series_id,
           e.name, e.tenant_id, e.status::text AS status, e.starts_at,
           coalesce(e.tz_name, v.tz_name) AS tz_name,
           row_number() OVER (PARTITION BY coalesce(e.series_id, e.id)
                              ORDER BY e.status = 'cancelled', e.starts_at < now(),
                                       abs(extract(epoch FROM e.starts_at - now()))) AS pick,
           count(*) OVER (PARTITION BY coalesce(e.series_id, e.id)) AS dates
      FROM events e
      LEFT JOIN venues v ON v.id = e.venue_id
     WHERE e.status <> 'draft'`,
  venue: sql`
    SELECT v.id AS item_id, v.id AS grp, NULL::uuid AS series_id,
           v.name, v.tenant_id, v.status::text AS status, NULL::timestamptz AS starts_at,
           NULL::text AS tz_name, 1 AS pick, 1 AS dates
      FROM venues v
     WHERE v.status <> 'draft'`,
  membership: sql`
    SELECT m.id AS item_id, m.id AS grp, NULL::uuid AS series_id,
           m.name, m.tenant_id, m.status::text AS status, NULL::timestamptz AS starts_at,
           NULL::text AS tz_name, 1 AS pick, 1 AS dates
      FROM memberships m
     WHERE m.status <> 'draft'`,
};

/** The bookings.item_type a listing type sells: a venue sells court slots. */
const BOOKING_ITEM_TYPE: Record<EngagementType, string> = {
  event: 'event',
  venue: 'slot',
  membership: 'membership',
};

export interface AdminEngagementRow {
  itemType: EngagementType;
  /** The listing, or for a recurring event the date that stands for it. */
  itemId: string;
  /** Recurring events only. */
  seriesId: string | null;
  /** How many dates a recurring event has; 1 otherwise. */
  dates: number;
  name: string;
  status: string;
  /** Events only. */
  startsAt: string | null;
  /** IANA zone the event's date reads in. Events only. */
  timeZone: string | null;
  tenantId: string;
  tenantName: string;
  views: number;
  viewers: number;
  likes: number;
  shares: number;
  bookings: number;
}

export interface AdminEngagementTotals {
  listings: number;
  views: number;
  likes: number;
  shares: number;
  bookings: number;
}

export const adminEngagementRoutes: FastifyPluginAsync = async (app) => {
  app.get('/v1/admin/engagement', { preHandler: requireAuth }, async (req, reply) => {
    const user = await currentUser(req);
    const platformTenantId = await getPlatformTenantId();
    const ctx = await requireTenantMembership(user.id, platformTenantId);
    assertCap(ctx, 'admin.tenants.read');

    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new BadRequest('Invalid query parameters', 'bad_request', { issues: parsed.error.issues });
    }
    const type = parsed.data.type ?? 'event';
    const wantCsv = parsed.data.format === 'csv';
    const limit = wantCsv ? CSV_MAX_ROWS : Math.min(parsed.data.limit ?? 50, 200);
    const offset = wantCsv ? 0 : Number(parsed.data.cursor ?? 0);
    const since = parsed.data.since;

    const activitySince = since ? sql`AND ca.created_at >= ${since}::timestamptz` : sql``;
    const likesSince = since ? sql`AND w.created_at >= ${since}::timestamptz` : sql``;
    const bookingsSince = since ? sql`AND b.created_at >= ${since}::timestamptz` : sql``;
    const like = parsed.data.q ? `%${parsed.data.q.toLowerCase()}%` : null;
    const nameFilter = like ? sql`AND (lower(o.name) LIKE ${like} OR lower(t.name) LIKE ${like})` : sql``;

    const raw = await db.execute<Record<string, unknown>>(sql`
      WITH occ AS (${LISTINGS[type]}),
      listing AS (
        SELECT o.grp, o.item_id, o.series_id, o.dates, o.name, o.status, o.starts_at, o.tz_name,
               t.id AS tenant_id, t.name AS tenant_name
          FROM occ o
          JOIN tenants t ON t.id = o.tenant_id
         WHERE o.pick = 1 ${nameFilter}
      ),
      -- Every listing counted under a matched row: a recurring event's dates.
      member AS (
        SELECT o.item_id, o.grp FROM occ o JOIN listing l ON l.grp = o.grp
      ),
      act AS (
        SELECT m.grp,
               count(*) FILTER (WHERE ${isViewSql('ca')})                 AS views,
               count(DISTINCT ca.user_id) FILTER (WHERE ${isViewSql('ca')}) AS viewers,
               count(*) FILTER (WHERE ${isShareSql('ca')})                AS shares
          FROM consumer_activity ca
          JOIN member m ON m.item_id = ca.item_id
         WHERE ca.item_type = ${type} ${activitySince}
         GROUP BY m.grp
      ),
      liked AS (
        SELECT m.grp, count(DISTINCT w.user_id) AS likes
          FROM wishlist_items w
          JOIN member m ON m.item_id = w.item_id
         WHERE w.item_type = ${type}::wishlist_item_type ${likesSince}
         GROUP BY m.grp
      ),
      booked AS (
        SELECT m.grp, count(*) AS bookings
          FROM bookings b
          JOIN member m ON m.item_id = ${itemKeySql('b')}
         WHERE b.item_type = ${BOOKING_ITEM_TYPE[type]}::booking_item_type
           AND b.channel = 'circls'
           AND b.status IN ('confirmed', 'completed', 'no_show')
           ${bookingsSince}
         GROUP BY m.grp
      ),
      rows AS (
        SELECT l.*,
               coalesce(a.views, 0)     AS views,
               coalesce(a.viewers, 0)   AS viewers,
               coalesce(lk.likes, 0)    AS likes,
               coalesce(a.shares, 0)    AS shares,
               coalesce(bk.bookings, 0) AS bookings
          FROM listing l
          LEFT JOIN act a     ON a.grp = l.grp
          LEFT JOIN liked lk  ON lk.grp = l.grp
          LEFT JOIN booked bk ON bk.grp = l.grp
      )
      SELECT r.*,
             count(*)        OVER () AS total_listings,
             sum(r.views)    OVER () AS total_views,
             sum(r.likes)    OVER () AS total_likes,
             sum(r.shares)   OVER () AS total_shares,
             sum(r.bookings) OVER () AS total_bookings
        FROM rows r
       ORDER BY r.views DESC, r.likes DESC, r.shares DESC, r.bookings DESC, r.name, r.grp
       LIMIT ${limit + 1} OFFSET ${offset}
    `);

    const all = raw as unknown as Record<string, unknown>[];
    const hasMore = all.length > limit;
    const pageRows = hasMore ? all.slice(0, limit) : all;

    const rows: AdminEngagementRow[] = pageRows.map((r) => ({
      itemType: type,
      itemId: r['item_id'] as string,
      seriesId: (r['series_id'] as string | null) ?? null,
      dates: Number(r['dates'] ?? 1),
      name: r['name'] as string,
      status: r['status'] as string,
      startsAt: r['starts_at'] == null ? null : new Date(r['starts_at'] as string).toISOString(),
      timeZone: (r['tz_name'] as string | null) ?? null,
      tenantId: r['tenant_id'] as string,
      tenantName: r['tenant_name'] as string,
      views: Number(r['views'] ?? 0),
      viewers: Number(r['viewers'] ?? 0),
      likes: Number(r['likes'] ?? 0),
      shares: Number(r['shares'] ?? 0),
      bookings: Number(r['bookings'] ?? 0),
    }));

    if (wantCsv) {
      const csv = csvDocument(
        ['Listing ID', 'Series ID', 'Type', 'Name', 'Dates', 'Status', 'Starts', 'Time zone',
         'Organiser', 'Organiser ID', 'Views', 'Viewers', 'Likes', 'Shares', 'Bookings'],
        rows.map((r) => [
          r.itemId, r.seriesId, r.itemType, r.name, r.dates, r.status, r.startsAt, r.timeZone,
          r.tenantName, r.tenantId, r.views, r.viewers, r.likes, r.shares, r.bookings,
        ]),
      );
      return reply
        .type('text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="engagement-${type}s.csv"`)
        .send(csv);
    }

    // Window totals ride on every row; an empty result has none to carry them.
    const first = all[0];
    const totals: AdminEngagementTotals = {
      listings: Number(first?.['total_listings'] ?? 0),
      views: Number(first?.['total_views'] ?? 0),
      likes: Number(first?.['total_likes'] ?? 0),
      shares: Number(first?.['total_shares'] ?? 0),
      bookings: Number(first?.['total_bookings'] ?? 0),
    };
    return { rows, totals, nextCursor: hasMore ? String(offset + limit) : null };
  });
};
