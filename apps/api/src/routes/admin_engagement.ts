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
 * `since` narrows every count to what happened at or after it (a like counts
 * from when it was made). Drafts are left out: nobody outside the partner
 * could see them. Rows are ordered by views, then likes, shares, bookings and
 * name; the order is computed, so `cursor` is simply the offset of the next
 * page. Every row also carries the totals across all matching listings, for
 * the summary tiles. `format=csv` returns every matching row, capped at
 * CSV_MAX_ROWS.
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

/** The listing table behind each type, minus drafts. Events add their start. */
const LISTINGS: Record<EngagementType, SQL> = {
  event: sql`SELECT e.id, e.name, e.tenant_id, e.status::text AS status, e.starts_at
               FROM events e WHERE e.status <> 'draft'`,
  venue: sql`SELECT v.id, v.name, v.tenant_id, v.status::text AS status, NULL::timestamptz AS starts_at
               FROM venues v WHERE v.status <> 'draft'`,
  membership: sql`SELECT m.id, m.name, m.tenant_id, m.status::text AS status, NULL::timestamptz AS starts_at
                    FROM memberships m WHERE m.status <> 'draft'`,
};

/** The bookings.item_type a listing type sells: a venue sells court slots. */
const BOOKING_ITEM_TYPE: Record<EngagementType, string> = {
  event: 'event',
  venue: 'slot',
  membership: 'membership',
};

export interface AdminEngagementRow {
  itemType: EngagementType;
  itemId: string;
  name: string;
  status: string;
  /** Events only. */
  startsAt: string | null;
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
    const nameFilter = parsed.data.q
      ? sql`WHERE lower(l.name) LIKE ${`%${parsed.data.q.toLowerCase()}%`}
               OR lower(t.name) LIKE ${`%${parsed.data.q.toLowerCase()}%`}`
      : sql``;

    const raw = await db.execute<Record<string, unknown>>(sql`
      WITH listing AS (${LISTINGS[type]}),
      act AS (
        SELECT ca.item_id,
               count(*) FILTER (WHERE ${isViewSql('ca')})                 AS views,
               count(DISTINCT ca.user_id) FILTER (WHERE ${isViewSql('ca')}) AS viewers,
               count(*) FILTER (WHERE ${isShareSql('ca')})                AS shares
          FROM consumer_activity ca
         WHERE ca.item_type = ${type} AND ca.item_id IS NOT NULL ${activitySince}
         GROUP BY ca.item_id
      ),
      liked AS (
        SELECT w.item_id, count(*) AS likes
          FROM wishlist_items w
         WHERE w.item_type = ${type}::wishlist_item_type ${likesSince}
         GROUP BY w.item_id
      ),
      booked AS (
        SELECT ${itemKeySql('b')} AS item_id, count(*) AS bookings
          FROM bookings b
         WHERE b.item_type = ${BOOKING_ITEM_TYPE[type]}::booking_item_type
           AND b.channel = 'circls'
           AND b.status IN ('confirmed', 'completed', 'no_show')
           ${bookingsSince}
         GROUP BY 1
      ),
      rows AS (
        SELECT l.id, l.name, l.status, l.starts_at, t.id AS tenant_id, t.name AS tenant_name,
               coalesce(a.views, 0)    AS views,
               coalesce(a.viewers, 0)  AS viewers,
               coalesce(lk.likes, 0)   AS likes,
               coalesce(a.shares, 0)   AS shares,
               coalesce(bk.bookings, 0) AS bookings
          FROM listing l
          JOIN tenants t ON t.id = l.tenant_id
          LEFT JOIN act a     ON a.item_id = l.id
          LEFT JOIN liked lk  ON lk.item_id = l.id
          LEFT JOIN booked bk ON bk.item_id = l.id
          ${nameFilter}
      )
      SELECT r.*,
             count(*)       OVER () AS total_listings,
             sum(r.views)   OVER () AS total_views,
             sum(r.likes)   OVER () AS total_likes,
             sum(r.shares)  OVER () AS total_shares,
             sum(r.bookings) OVER () AS total_bookings
        FROM rows r
       ORDER BY r.views DESC, r.likes DESC, r.shares DESC, r.bookings DESC, r.name, r.id
       LIMIT ${limit + 1} OFFSET ${offset}
    `);

    const all = raw as unknown as Record<string, unknown>[];
    const hasMore = all.length > limit;
    const pageRows = hasMore ? all.slice(0, limit) : all;

    const rows: AdminEngagementRow[] = pageRows.map((r) => ({
      itemType: type,
      itemId: r['id'] as string,
      name: r['name'] as string,
      status: r['status'] as string,
      startsAt: r['starts_at'] == null ? null : new Date(r['starts_at'] as string).toISOString(),
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
        ['Listing ID', 'Type', 'Name', 'Status', 'Starts', 'Organiser', 'Organiser ID',
         'Views', 'Viewers', 'Likes', 'Shares', 'Bookings'],
        rows.map((r) => [
          r.itemId, r.itemType, r.name, r.status, r.startsAt, r.tenantName, r.tenantId,
          r.views, r.viewers, r.likes, r.shares, r.bookings,
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
