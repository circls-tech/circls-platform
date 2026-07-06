import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { BadRequest } from '../lib/errors.js';
import { csvDocument } from '../lib/csv.js';
import { getPlatformTenantId } from '../lib/authz/platform_tenant.js';
import { assertCap } from '../middleware/require_cap.js';
import { requireAuth } from '../middleware/require_auth.js';
import { currentUser } from '../middleware/current_user.js';
import { requireTenantMembership } from '../middleware/tenant_context.js';

/**
 * Platform-admin user reports. Mounted under /v1/admin/users/*. Gated the same
 * way as admin_tenants.ts (platform membership + admin.tenants.read).
 *
 * Two datasets:
 *  - consumers: one row per user account, with booking/activity/login rollups
 *    (events booked, events opened, minutes in app from consumer_activity
 *    session spans, interests, last login).
 *  - partners: one row per tenant membership on a non-platform tenant, with
 *    the member's contact info and tenant rollups.
 *
 * Both support `format=csv`, which ignores the cursor and streams the full
 * (filtered) dataset as a download, capped at CSV_MAX_ROWS.
 */

const CSV_MAX_ROWS = 10_000;

const listQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  q: z.string().min(1).max(200).optional(),
  /** Only rows created at/after this instant ("new users since…"). */
  since: z.string().datetime({ offset: true }).optional(),
  format: z.enum(['json', 'csv']).optional(),
});

interface AdminConsumerUserRow {
  id: string;
  displayName: string | null;
  username: string | null;
  email: string | null;
  phoneE164: string | null;
  interests: string[];
  status: string;
  createdAt: string;
  eventsBooked: number;
  totalBookings: number;
  eventsOpened: number;
  sessionCount: number;
  minutesInApp: number;
  lastActiveAt: string | null;
  loginCount: number;
  lastLoginAt: string | null;
}

interface AdminPartnerUserRow {
  userId: string;
  displayName: string | null;
  email: string | null;
  phoneE164: string | null;
  role: string;
  memberSince: string;
  userCreatedAt: string;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  tenantStatus: string;
  subscriptionStatus: string;
  teamSize: number;
  venueCount: number;
  tenantBookings30d: number;
  loginCount: number;
  lastLoginAt: string | null;
}

function isoOrNull(v: unknown): string | null {
  return v == null ? null : new Date(v as string).toISOString();
}

// Cursor helpers. Consumers page on (created_at, id); partners page on
// (member created_at, tenant_id, user_id) since the membership PK is composite.
function decodeCursorParts(cursor: string, parts: number): string[] | null {
  const split = cursor.split('|');
  if (split.length !== parts || split.some((p) => !p)) return null;
  return split;
}

export const adminUserRoutes: FastifyPluginAsync = async (app) => {
  // ── GET /v1/admin/users/consumers ───────────────────────────────────────────
  app.get(
    '/v1/admin/users/consumers',
    { preHandler: requireAuth },
    async (req, reply) => {
      const user = await currentUser(req);
      const platformTenantId = await getPlatformTenantId();
      const ctx = await requireTenantMembership(user.id, platformTenantId);
      assertCap(ctx, 'admin.tenants.read');

      const parsed = listQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new BadRequest('Invalid query parameters', 'bad_request', { issues: parsed.error.issues });
      }
      const wantCsv = parsed.data.format === 'csv';
      const limit = wantCsv ? CSV_MAX_ROWS : Math.min(parsed.data.limit ?? 50, 200);
      const fetchLimit = limit + 1;

      const conditions: ReturnType<typeof sql>[] = [sql`1=1`];
      if (parsed.data.q) {
        const like = `%${parsed.data.q.toLowerCase()}%`;
        conditions.push(
          sql`(lower(coalesce(u.display_name, '')) like ${like}
            or lower(coalesce(u.username, '')) like ${like}
            or lower(coalesce(u.email, '')) like ${like}
            or lower(coalesce(u.phone_e164, '')) like ${like})`,
        );
      }
      if (parsed.data.since) {
        conditions.push(sql`u.created_at >= ${parsed.data.since}::timestamptz`);
      }
      if (!wantCsv && parsed.data.cursor) {
        const decoded = decodeCursorParts(parsed.data.cursor, 2);
        if (decoded) {
          conditions.push(
            sql`(u.created_at, u.id) < (${decoded[0]}::timestamptz, ${decoded[1]}::uuid)`,
          );
        }
      }
      const whereClause = conditions.reduce((acc, c) => sql`${acc} AND ${c}`);

      const rawRows = await db.execute<Record<string, unknown>>(sql`
        SELECT
          u.id,
          u.display_name,
          u.username,
          u.email,
          u.phone_e164,
          u.interests,
          u.status,
          u.created_at,
          (SELECT count(*) FROM bookings b
             WHERE b.customer_user_id = u.id
               AND b.item_type = 'event'
               AND b.status <> 'cancelled')                                               AS events_booked,
          (SELECT count(*) FROM bookings b
             WHERE b.customer_user_id = u.id
               AND b.status <> 'cancelled')                                               AS total_bookings,
          (SELECT count(DISTINCT ca.item_id) FROM consumer_activity ca
             WHERE ca.user_id = u.id
               AND ca.item_type = 'event'
               AND ca.item_id IS NOT NULL)                                                AS events_opened,
          (SELECT count(DISTINCT ca.session_id) FROM consumer_activity ca
             WHERE ca.user_id = u.id AND ca.session_id IS NOT NULL)                       AS session_count,
          (SELECT coalesce(round(sum(s.dur) / 60.0), 0) FROM (
             SELECT extract(epoch FROM max(ca.created_at) - min(ca.created_at)) AS dur
               FROM consumer_activity ca
              WHERE ca.user_id = u.id AND ca.session_id IS NOT NULL
              GROUP BY ca.session_id) s)                                                  AS minutes_in_app,
          (SELECT max(ca.created_at) FROM consumer_activity ca
             WHERE ca.user_id = u.id)                                                     AS last_active_at,
          (SELECT count(*) FROM login_events le WHERE le.user_id = u.id)                  AS login_count,
          (SELECT max(le.created_at) FROM login_events le WHERE le.user_id = u.id)        AS last_login_at
        FROM users u
        WHERE ${whereClause}
        ORDER BY u.created_at DESC, u.id DESC
        LIMIT ${fetchLimit}
      `);

      const rows = rawRows as unknown as Record<string, unknown>[];
      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;

      const items: AdminConsumerUserRow[] = pageRows.map((r) => ({
        id: r['id'] as string,
        displayName: (r['display_name'] as string | null) ?? null,
        username: (r['username'] as string | null) ?? null,
        email: (r['email'] as string | null) ?? null,
        phoneE164: (r['phone_e164'] as string | null) ?? null,
        interests: (r['interests'] as string[] | null) ?? [],
        status: r['status'] as string,
        createdAt: new Date(r['created_at'] as string).toISOString(),
        eventsBooked: Number(r['events_booked'] ?? 0),
        totalBookings: Number(r['total_bookings'] ?? 0),
        eventsOpened: Number(r['events_opened'] ?? 0),
        sessionCount: Number(r['session_count'] ?? 0),
        minutesInApp: Number(r['minutes_in_app'] ?? 0),
        lastActiveAt: isoOrNull(r['last_active_at']),
        loginCount: Number(r['login_count'] ?? 0),
        lastLoginAt: isoOrNull(r['last_login_at']),
      }));

      if (wantCsv) {
        const csv = csvDocument(
          ['User ID', 'Name', 'Username', 'Email', 'Phone', 'Interests', 'Status', 'Signed up',
           'Events booked', 'Total bookings', 'Events opened', 'Sessions',
           'Minutes in app', 'Last active', 'Logins', 'Last login'],
          items.map((u) => [
            u.id, u.displayName, u.username, u.email, u.phoneE164, u.interests.join('; '),
            u.status, u.createdAt, u.eventsBooked, u.totalBookings, u.eventsOpened,
            u.sessionCount, u.minutesInApp, u.lastActiveAt, u.loginCount, u.lastLoginAt,
          ]),
        );
        return reply
          .type('text/csv; charset=utf-8')
          .header('content-disposition', 'attachment; filename="consumer-users.csv"')
          .send(csv);
      }

      let nextCursor: string | null = null;
      if (hasMore && pageRows.length > 0) {
        const last = pageRows[pageRows.length - 1]!;
        nextCursor = `${new Date(last['created_at'] as string).toISOString()}|${last['id'] as string}`;
      }
      return { rows: items, nextCursor };
    },
  );

  // ── GET /v1/admin/users/partners ────────────────────────────────────────────
  app.get(
    '/v1/admin/users/partners',
    { preHandler: requireAuth },
    async (req, reply) => {
      const user = await currentUser(req);
      const platformTenantId = await getPlatformTenantId();
      const ctx = await requireTenantMembership(user.id, platformTenantId);
      assertCap(ctx, 'admin.tenants.read');

      const parsed = listQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new BadRequest('Invalid query parameters', 'bad_request', { issues: parsed.error.issues });
      }
      const wantCsv = parsed.data.format === 'csv';
      const limit = wantCsv ? CSV_MAX_ROWS : Math.min(parsed.data.limit ?? 50, 200);
      const fetchLimit = limit + 1;

      const conditions: ReturnType<typeof sql>[] = [sql`t.is_platform = FALSE`];
      if (parsed.data.q) {
        const like = `%${parsed.data.q.toLowerCase()}%`;
        conditions.push(
          sql`(lower(coalesce(u.display_name, '')) like ${like}
            or lower(coalesce(u.email, '')) like ${like}
            or lower(coalesce(u.phone_e164, '')) like ${like}
            or lower(t.name) like ${like}
            or lower(t.slug) like ${like})`,
        );
      }
      if (parsed.data.since) {
        conditions.push(sql`tm.created_at >= ${parsed.data.since}::timestamptz`);
      }
      if (!wantCsv && parsed.data.cursor) {
        const decoded = decodeCursorParts(parsed.data.cursor, 3);
        if (decoded) {
          conditions.push(sql`
            (tm.created_at, tm.tenant_id, tm.user_id)
              < (${decoded[0]}::timestamptz, ${decoded[1]}::uuid, ${decoded[2]}::uuid)`);
        }
      }
      const whereClause = conditions.reduce((acc, c) => sql`${acc} AND ${c}`);

      const rawRows = await db.execute<Record<string, unknown>>(sql`
        SELECT
          u.id                                                                            AS user_id,
          u.display_name,
          u.email,
          u.phone_e164,
          u.created_at                                                                    AS user_created_at,
          tm.role,
          tm.created_at                                                                   AS member_since,
          t.id                                                                            AS tenant_id,
          t.name                                                                          AS tenant_name,
          t.slug                                                                          AS tenant_slug,
          t.status                                                                        AS tenant_status,
          t.subscription_status,
          (SELECT count(*) FROM tenant_members tm2 WHERE tm2.tenant_id = t.id)            AS team_size,
          (SELECT count(*) FROM venues v WHERE v.tenant_id = t.id)                        AS venue_count,
          (SELECT count(*) FROM bookings b
             WHERE b.tenant_id = t.id
               AND b.created_at >= now() - interval '30 days')                            AS tenant_bookings_30d,
          (SELECT count(*) FROM login_events le
             WHERE le.user_id = u.id AND le.source = 'partners')                          AS login_count,
          (SELECT max(le.created_at) FROM login_events le
             WHERE le.user_id = u.id AND le.source = 'partners')                          AS last_login_at
        FROM tenant_members tm
        JOIN users u   ON u.id = tm.user_id
        JOIN tenants t ON t.id = tm.tenant_id
        WHERE ${whereClause}
        ORDER BY tm.created_at DESC, tm.tenant_id DESC, tm.user_id DESC
        LIMIT ${fetchLimit}
      `);

      const rows = rawRows as unknown as Record<string, unknown>[];
      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;

      const items: AdminPartnerUserRow[] = pageRows.map((r) => ({
        userId: r['user_id'] as string,
        displayName: (r['display_name'] as string | null) ?? null,
        email: (r['email'] as string | null) ?? null,
        phoneE164: (r['phone_e164'] as string | null) ?? null,
        role: r['role'] as string,
        memberSince: new Date(r['member_since'] as string).toISOString(),
        userCreatedAt: new Date(r['user_created_at'] as string).toISOString(),
        tenantId: r['tenant_id'] as string,
        tenantName: r['tenant_name'] as string,
        tenantSlug: r['tenant_slug'] as string,
        tenantStatus: r['tenant_status'] as string,
        subscriptionStatus: r['subscription_status'] as string,
        teamSize: Number(r['team_size'] ?? 0),
        venueCount: Number(r['venue_count'] ?? 0),
        tenantBookings30d: Number(r['tenant_bookings_30d'] ?? 0),
        loginCount: Number(r['login_count'] ?? 0),
        lastLoginAt: isoOrNull(r['last_login_at']),
      }));

      if (wantCsv) {
        const csv = csvDocument(
          ['User ID', 'Name', 'Email', 'Phone', 'Role', 'Member since', 'User signed up',
           'Tenant', 'Tenant slug', 'Tenant status', 'Subscription', 'Team size',
           'Venues', 'Tenant bookings (30d)', 'Portal logins', 'Last login'],
          items.map((m) => [
            m.userId, m.displayName, m.email, m.phoneE164, m.role, m.memberSince,
            m.userCreatedAt, m.tenantName, m.tenantSlug, m.tenantStatus,
            m.subscriptionStatus, m.teamSize, m.venueCount, m.tenantBookings30d,
            m.loginCount, m.lastLoginAt,
          ]),
        );
        return reply
          .type('text/csv; charset=utf-8')
          .header('content-disposition', 'attachment; filename="partner-users.csv"')
          .send(csv);
      }

      let nextCursor: string | null = null;
      if (hasMore && pageRows.length > 0) {
        const last = pageRows[pageRows.length - 1]!;
        nextCursor = [
          new Date(last['member_since'] as string).toISOString(),
          last['tenant_id'] as string,
          last['user_id'] as string,
        ].join('|');
      }
      return { rows: items, nextCursor };
    },
  );
};
