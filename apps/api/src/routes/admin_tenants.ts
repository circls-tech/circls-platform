import type { FastifyPluginAsync } from 'fastify';
import { and, eq, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { events, tenantMembers, tenants, users } from '../db/schema/index.js';
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

const bps = z.number().int().min(0).max(10_000);

/** All-optional patch of the tenant billing knobs; must not be empty. */
const tenantBillingBodySchema = z
  .object({
    commissionBps: bps.optional(),
    consumerCommissionBps: bps.optional(),
    customerFeeShareBps: bps.optional(),
    orgFeeShareBps: bps.optional(),
    advancePayoutBps: bps.optional(),
  })
  .refine((o) => Object.values(o).some((v) => v !== undefined), { message: 'Empty patch' });

/** Per-event overrides: explicit null clears the override (inherit the
 *  tenant's rate); 0 is a real "disabled for this event" override. */
const eventBillingBodySchema = z
  .object({
    partnerCommissionBps: bps.nullable().optional(),
    consumerCommissionBps: bps.nullable().optional(),
    advancePayoutBps: bps.nullable().optional(),
  })
  .refine((o) => Object.values(o).some((v) => v !== undefined), { message: 'Empty patch' });

/** The five admin-editable billing fields, for audit before/after blobs. */
function billingFields(t: {
  commissionBps: number;
  consumerCommissionBps: number;
  customerFeeShareBps: number;
  orgFeeShareBps: number;
  advancePayoutBps: number;
}): Record<string, number> {
  return {
    commissionBps: t.commissionBps,
    consumerCommissionBps: t.consumerCommissionBps,
    customerFeeShareBps: t.customerFeeShareBps,
    orgFeeShareBps: t.orgFeeShareBps,
    advancePayoutBps: t.advancePayoutBps,
  };
}

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

  // ── PATCH /v1/admin/tenants/:id/billing — edit the billing knobs ───────────
  app.patch(
    '/v1/admin/tenants/:id/billing',
    { preHandler: requireAuth },
    async (req) => {
      const user = await currentUser(req);
      const platformTenantId = await getPlatformTenantId();
      const ctx = await requireTenantMembership(user.id, platformTenantId);
      assertCap(ctx, 'admin.tenants.billing');

      const params = tenantIdParamSchema.safeParse(req.params);
      if (!params.success) {
        throw new BadRequest('Invalid tenant id', 'bad_request', { issues: params.error.issues });
      }
      const body = tenantBillingBodySchema.safeParse(req.body);
      if (!body.success) {
        throw new BadRequest('Invalid billing patch', 'bad_request', { issues: body.error.issues });
      }
      const { id } = params.data;
      const patch = body.data;

      return db.transaction(async (tx) => {
        const before = await tx.query.tenants.findFirst({ where: eq(tenants.id, id) });
        if (!before) throw new NotFound('Tenant not found', 'tenant_not_found');

        // Validate the MERGED fee split so a partial patch can't sneak past
        // 100% (the DB CHECK is the backstop).
        const mergedCustomer = patch.customerFeeShareBps ?? before.customerFeeShareBps;
        const mergedOrg = patch.orgFeeShareBps ?? before.orgFeeShareBps;
        if (mergedCustomer + mergedOrg > 10_000) {
          throw new BadRequest(
            'Customer + org gateway-fee shares exceed 100%',
            'fee_share_split_exceeds_total',
            { customerFeeShareBps: mergedCustomer, orgFeeShareBps: mergedOrg },
          );
        }

        const [after] = await tx
          .update(tenants)
          .set({
            ...(patch.commissionBps !== undefined ? { commissionBps: patch.commissionBps } : {}),
            ...(patch.consumerCommissionBps !== undefined
              ? { consumerCommissionBps: patch.consumerCommissionBps }
              : {}),
            ...(patch.customerFeeShareBps !== undefined
              ? { customerFeeShareBps: patch.customerFeeShareBps }
              : {}),
            ...(patch.orgFeeShareBps !== undefined ? { orgFeeShareBps: patch.orgFeeShareBps } : {}),
            ...(patch.advancePayoutBps !== undefined
              ? { advancePayoutBps: patch.advancePayoutBps }
              : {}),
          })
          .where(eq(tenants.id, id))
          .returning();
        if (!after) throw new NotFound('Tenant not found', 'tenant_not_found');

        await writeAudit(
          tx,
          { tenantId: id, actorUserId: user.id },
          'tenant.billing_updated',
          'tenant',
          id,
          billingFields(before),
          billingFields(after),
        );
        return after;
      });
    },
  );

  // ── GET /v1/admin/tenants/:id/events — events for the Billing tab ──────────
  // Cursor-paginated (created_at, id) like the tenants list; carries the
  // per-event billing overrides so the admin can edit them inline.
  app.get(
    '/v1/admin/tenants/:id/events',
    { preHandler: requireAuth },
    async (req) => {
      const user = await currentUser(req);
      const platformTenantId = await getPlatformTenantId();
      const ctx = await requireTenantMembership(user.id, platformTenantId);
      assertCap(ctx, 'admin.tenants.billing');

      const params = tenantIdParamSchema.safeParse(req.params);
      if (!params.success) {
        throw new BadRequest('Invalid tenant id', 'bad_request', { issues: params.error.issues });
      }
      const query = listQuerySchema.safeParse(req.query);
      if (!query.success) {
        throw new BadRequest('Invalid query', 'bad_request', { issues: query.error.issues });
      }
      const limit = Math.min(query.data.limit ?? 50, 200);

      const conditions = [eq(events.tenantId, params.data.id)];
      if (query.data.cursor) {
        const decoded = decodeCursor(query.data.cursor);
        if (decoded) {
          conditions.push(
            or(
              lt(events.createdAt, new Date(decoded.ts)),
              and(eq(events.createdAt, new Date(decoded.ts)), lt(events.id, decoded.id)),
            )!,
          );
        }
      }

      const rows = await db
        .select({
          id: events.id,
          name: events.name,
          startsAt: events.startsAt,
          status: events.status,
          partnerCommissionBps: events.partnerCommissionBps,
          consumerCommissionBps: events.consumerCommissionBps,
          advancePayoutBps: events.advancePayoutBps,
          createdAt: events.createdAt,
        })
        .from(events)
        .where(and(...conditions))
        .orderBy(sql`${events.createdAt} desc, ${events.id} desc`)
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page[page.length - 1];
      return {
        rows: page.map((e) => ({
          id: e.id,
          name: e.name,
          startsAt: e.startsAt ? new Date(e.startsAt).toISOString() : null,
          status: e.status,
          partnerCommissionBps: e.partnerCommissionBps,
          consumerCommissionBps: e.consumerCommissionBps,
          advancePayoutBps: e.advancePayoutBps,
        })),
        nextCursor:
          hasMore && last ? encodeCursor(new Date(last.createdAt as unknown as string).toISOString(), last.id) : null,
      };
    },
  );

  // ── PATCH /v1/admin/events/:id/billing — per-event override edit ───────────
  app.patch(
    '/v1/admin/events/:id/billing',
    { preHandler: requireAuth },
    async (req) => {
      const user = await currentUser(req);
      const platformTenantId = await getPlatformTenantId();
      const ctx = await requireTenantMembership(user.id, platformTenantId);
      assertCap(ctx, 'admin.tenants.billing');

      const params = tenantIdParamSchema.safeParse(req.params);
      if (!params.success) {
        throw new BadRequest('Invalid event id', 'bad_request', { issues: params.error.issues });
      }
      const body = eventBillingBodySchema.safeParse(req.body);
      if (!body.success) {
        throw new BadRequest('Invalid billing patch', 'bad_request', { issues: body.error.issues });
      }
      const { id } = params.data;
      const patch = body.data;

      return db.transaction(async (tx) => {
        const [before] = await tx.select().from(events).where(eq(events.id, id)).limit(1);
        if (!before) throw new NotFound('Event not found', 'event_not_found');

        const [after] = await tx
          .update(events)
          .set({
            ...(patch.partnerCommissionBps !== undefined
              ? { partnerCommissionBps: patch.partnerCommissionBps }
              : {}),
            ...(patch.consumerCommissionBps !== undefined
              ? { consumerCommissionBps: patch.consumerCommissionBps }
              : {}),
            ...(patch.advancePayoutBps !== undefined
              ? { advancePayoutBps: patch.advancePayoutBps }
              : {}),
          })
          .where(eq(events.id, id))
          .returning();
        if (!after) throw new NotFound('Event not found', 'event_not_found');

        // Audit under the event's OWNING tenant so the change surfaces in that
        // tenant's scoped log.
        await writeAudit(
          tx,
          { tenantId: before.tenantId, actorUserId: user.id },
          'event.billing_updated',
          'event',
          id,
          {
            partnerCommissionBps: before.partnerCommissionBps,
            consumerCommissionBps: before.consumerCommissionBps,
            advancePayoutBps: before.advancePayoutBps,
          },
          {
            partnerCommissionBps: after.partnerCommissionBps,
            consumerCommissionBps: after.consumerCommissionBps,
            advancePayoutBps: after.advancePayoutBps,
          },
        );
        return {
          id: after.id,
          partnerCommissionBps: after.partnerCommissionBps,
          consumerCommissionBps: after.consumerCommissionBps,
          advancePayoutBps: after.advancePayoutBps,
        };
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
             WHERE created_at >= now() - interval '7 days')                               AS bookings_7d,
          (SELECT count(*) FROM users)                                                    AS users_total,
          (SELECT count(*) FROM users
             WHERE created_at >= now() - interval '24 hours')                             AS users_new_24h,
          (SELECT count(*) FROM users
             WHERE created_at >= now() - interval '7 days')                               AS users_new_7d,
          (SELECT count(DISTINCT user_id) FROM consumer_activity
             WHERE created_at >= now() - interval '24 hours')                             AS active_users_24h,
          (SELECT count(DISTINCT user_id) FROM consumer_activity
             WHERE created_at >= now() - interval '30 days')                              AS active_users_30d,
          (SELECT count(*) FROM login_events
             WHERE created_at >= now() - interval '24 hours')                             AS logins_24h,
          (SELECT count(*) FROM login_events
             WHERE created_at >= now() - interval '7 days')                               AS logins_7d
      `);
      const r = (rows as unknown as Record<string, unknown>[])[0] ?? {};
      return {
        tenantsTotal: Number(r['tenants_total'] ?? 0),
        tenantsActive: Number(r['tenants_active'] ?? 0),
        tenantsSuspended: Number(r['tenants_suspended'] ?? 0),
        bookings24h: Number(r['bookings_24h'] ?? 0),
        bookings7d: Number(r['bookings_7d'] ?? 0),
        usersTotal: Number(r['users_total'] ?? 0),
        usersNew24h: Number(r['users_new_24h'] ?? 0),
        usersNew7d: Number(r['users_new_7d'] ?? 0),
        activeUsers24h: Number(r['active_users_24h'] ?? 0),
        activeUsers30d: Number(r['active_users_30d'] ?? 0),
        logins24h: Number(r['logins_24h'] ?? 0),
        logins7d: Number(r['logins_7d'] ?? 0),
      };
    },
  );
};
