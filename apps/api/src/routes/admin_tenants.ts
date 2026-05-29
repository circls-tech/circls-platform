import type { FastifyPluginAsync } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { tenantMembers, tenants, users } from '../db/schema/index.js';
import { writeAudit } from '../lib/audit.js';
import { getPlatformTenantId } from '../lib/authz/platform_tenant.js';
import { BadRequest, NotFound } from '../lib/errors.js';
import { assertCap } from '../middleware/require_cap.js';
import { requireAuth } from '../middleware/require_auth.js';
import { currentUser } from '../middleware/current_user.js';
import { requireTenantMembership } from '../middleware/tenant_context.js';

/**
 * Platform-admin tenant management. Mounted under /v1/admin/tenants and
 * /v1/admin/stats. Every endpoint is gated via assertCap + getPlatformTenantId.
 * Suspend/reactivate write to audit_log with action='tenant.*';
 * audit rows carry tenantId so they also surface in the tenant-scoped log.
 */

interface AdminTenantListItem {
  id: string;
  name: string;
  slug: string;
  status: string;
  subscriptionStatus: string;
  createdAt: string;
  venueCount: number;
  bookingCount30d: number;
}

interface AdminTenantListPage {
  rows: AdminTenantListItem[];
  nextCursor: string | null;
}

function encodeCursor(createdAt: string, id: string): string {
  return `${createdAt}|${id}`;
}
function decodeCursor(cursor: string): { ts: string; id: string } | null {
  const idx = cursor.lastIndexOf('|');
  if (idx === -1) return null;
  const ts = cursor.slice(0, idx);
  const id = cursor.slice(idx + 1);
  if (!ts || !id) return null;
  return { ts, id };
}

const listQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  q: z.string().min(1).max(200).optional(),
});

const tenantIdParamSchema = z.object({ id: z.string().uuid() });

export const adminTenantRoutes: FastifyPluginAsync = async (app) => {
  // ── GET /v1/admin/tenants — paginated list with counts ─────────────────────
  app.get(
    '/v1/admin/tenants',
    { preHandler: requireAuth },
    async (req): Promise<AdminTenantListPage> => {
      const user = await currentUser(req);
      const platformTenantId = await getPlatformTenantId();
      const ctx = await requireTenantMembership(user.id, platformTenantId);
      assertCap(ctx, 'admin.tenants.read');

      const parsed = listQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new BadRequest('Invalid query parameters', 'bad_request', { issues: parsed.error.issues });
      }
      const limit = Math.min(parsed.data.limit ?? 50, 200);
      const fetchLimit = limit + 1;

      const conditions: ReturnType<typeof sql>[] = [sql`1=1`];
      if (parsed.data.q) {
        const like = `%${parsed.data.q.toLowerCase()}%`;
        conditions.push(sql`(lower(t.name) like ${like} or lower(t.slug) like ${like})`);
      }
      if (parsed.data.cursor) {
        const decoded = decodeCursor(parsed.data.cursor);
        if (decoded) {
          conditions.push(
            sql`(t.created_at, t.id) < (${decoded.ts}::timestamptz, ${decoded.id}::uuid)`,
          );
        }
      }
      const whereClause = conditions.reduce((acc, c) => sql`${acc} AND ${c}`);

      const rawRows = await db.execute<Record<string, unknown>>(sql`
        SELECT
          t.id,
          t.name,
          t.slug,
          t.status,
          t.subscription_status,
          t.created_at,
          (SELECT count(*) FROM venues v WHERE v.tenant_id = t.id)                       AS venue_count,
          (SELECT count(*) FROM bookings b
             WHERE b.tenant_id = t.id
               AND b.created_at >= now() - interval '30 days')                            AS booking_count_30d
        FROM tenants t
        WHERE ${whereClause}
        ORDER BY t.created_at DESC, t.id DESC
        LIMIT ${fetchLimit}
      `);

      const rows = rawRows as unknown as Record<string, unknown>[];
      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;

      const items: AdminTenantListItem[] = pageRows.map((r) => ({
        id: r['id'] as string,
        name: r['name'] as string,
        slug: r['slug'] as string,
        status: r['status'] as string,
        subscriptionStatus: r['subscription_status'] as string,
        createdAt: new Date(r['created_at'] as string).toISOString(),
        venueCount: Number(r['venue_count'] ?? 0),
        bookingCount30d: Number(r['booking_count_30d'] ?? 0),
      }));

      let nextCursor: string | null = null;
      if (hasMore && pageRows.length > 0) {
        const last = pageRows[pageRows.length - 1]!;
        nextCursor = encodeCursor(
          new Date(last['created_at'] as string).toISOString(),
          last['id'] as string,
        );
      }
      return { rows: items, nextCursor };
    },
  );

  // ── GET /v1/admin/tenants/:id — detail + members ───────────────────────────
  app.get(
    '/v1/admin/tenants/:id',
    { preHandler: requireAuth },
    async (req) => {
      const user = await currentUser(req);
      const platformTenantId = await getPlatformTenantId();
      const ctx = await requireTenantMembership(user.id, platformTenantId);
      assertCap(ctx, 'admin.tenants.read');

      const parsed = tenantIdParamSchema.safeParse(req.params);
      if (!parsed.success) {
        throw new BadRequest('Invalid tenant id', 'bad_request', { issues: parsed.error.issues });
      }
      const { id } = parsed.data;
      const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, id) });
      if (!tenant) throw new NotFound('Tenant not found', 'tenant_not_found');

      const memberRows = await db
        .select({
          userId: tenantMembers.userId,
          role: tenantMembers.role,
          createdAt: tenantMembers.createdAt,
          email: users.email,
          phoneE164: users.phoneE164,
          displayName: users.displayName,
        })
        .from(tenantMembers)
        .innerJoin(users, eq(users.id, tenantMembers.userId))
        .where(eq(tenantMembers.tenantId, id));

      return {
        tenant,
        members: memberRows.map((m) => ({
          userId: m.userId,
          role: m.role,
          email: m.email,
          phoneE164: m.phoneE164,
          displayName: m.displayName,
          createdAt: m.createdAt ? new Date(m.createdAt as unknown as string).toISOString() : null,
        })),
      };
    },
  );

  // ── POST /v1/admin/tenants/:id/suspend ─────────────────────────────────────
  app.post(
    '/v1/admin/tenants/:id/suspend',
    { preHandler: requireAuth },
    async (req) => {
      const user = await currentUser(req);
      const platformTenantId = await getPlatformTenantId();
      const ctx = await requireTenantMembership(user.id, platformTenantId);
      assertCap(ctx, 'admin.tenants.suspend');

      const parsed = tenantIdParamSchema.safeParse(req.params);
      if (!parsed.success) {
        throw new BadRequest('Invalid tenant id', 'bad_request', { issues: parsed.error.issues });
      }
      const { id } = parsed.data;
      const actorUserId = user.id;

      return db.transaction(async (tx) => {
        const before = await tx.query.tenants.findFirst({ where: eq(tenants.id, id) });
        if (!before) throw new NotFound('Tenant not found', 'tenant_not_found');

        const [after] = await tx
          .update(tenants)
          .set({ status: 'suspended' })
          .where(eq(tenants.id, id))
          .returning();
        if (!after) throw new NotFound('Tenant not found', 'tenant_not_found');

        await writeAudit(
          tx,
          { tenantId: id, actorUserId },
          'tenant.suspended',
          'tenant',
          id,
          { status: before.status },
          { status: after.status },
        );
        return after;
      });
    },
  );

  // ── POST /v1/admin/tenants/:id/reactivate ──────────────────────────────────
  app.post(
    '/v1/admin/tenants/:id/reactivate',
    { preHandler: requireAuth },
    async (req) => {
      const user = await currentUser(req);
      const platformTenantId = await getPlatformTenantId();
      const ctx = await requireTenantMembership(user.id, platformTenantId);
      assertCap(ctx, 'admin.tenants.suspend');

      const parsed = tenantIdParamSchema.safeParse(req.params);
      if (!parsed.success) {
        throw new BadRequest('Invalid tenant id', 'bad_request', { issues: parsed.error.issues });
      }
      const { id } = parsed.data;
      const actorUserId = user.id;

      return db.transaction(async (tx) => {
        const before = await tx.query.tenants.findFirst({ where: eq(tenants.id, id) });
        if (!before) throw new NotFound('Tenant not found', 'tenant_not_found');

        const [after] = await tx
          .update(tenants)
          .set({ status: 'active' })
          .where(eq(tenants.id, id))
          .returning();
        if (!after) throw new NotFound('Tenant not found', 'tenant_not_found');

        await writeAudit(
          tx,
          { tenantId: id, actorUserId },
          'tenant.reactivated',
          'tenant',
          id,
          { status: before.status },
          { status: after.status },
        );
        return after;
      });
    },
  );

  // ── GET /v1/admin/stats — platform-wide tiles for the dashboard ────────────
  // Co-mounted here so the dashboard has a single fetch; documented in plan.
  app.get(
    '/v1/admin/stats',
    { preHandler: requireAuth },
    async (req) => {
      const user = await currentUser(req);
      const platformTenantId = await getPlatformTenantId();
      const ctx = await requireTenantMembership(user.id, platformTenantId);
      assertCap(ctx, 'admin.tenants.read');
      const rows = await db.execute<Record<string, unknown>>(sql`
        SELECT
          (SELECT count(*) FROM tenants)                                                  AS tenants_total,
          (SELECT count(*) FROM tenants WHERE status = 'active')                          AS tenants_active,
          (SELECT count(*) FROM tenants WHERE status = 'suspended')                       AS tenants_suspended,
          (SELECT count(*) FROM bookings
             WHERE created_at >= now() - interval '24 hours')                             AS bookings_24h,
          (SELECT count(*) FROM bookings
             WHERE created_at >= now() - interval '7 days')                               AS bookings_7d
      `);
      const r = (rows as unknown as Record<string, unknown>[])[0] ?? {};
      return {
        tenantsTotal: Number(r['tenants_total'] ?? 0),
        tenantsActive: Number(r['tenants_active'] ?? 0),
        tenantsSuspended: Number(r['tenants_suspended'] ?? 0),
        bookings24h: Number(r['bookings_24h'] ?? 0),
        bookings7d: Number(r['bookings_7d'] ?? 0),
      };
    },
  );
};
