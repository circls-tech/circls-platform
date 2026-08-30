import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { getPlatformTenantId } from '../lib/authz/platform_tenant.js';
import { BadRequest } from '../lib/errors.js';
import { assertCap } from '../middleware/require_cap.js';
import { requireAuth } from '../middleware/require_auth.js';
import { currentUser } from '../middleware/current_user.js';
import { requireTenantMembership } from '../middleware/tenant_context.js';

/**
 * Platform-admin audit log search. Complements the tenant-scoped
 * /v1/tenants/:id/audit-log by letting support drill into the entire stream
 * across tenants, with filters by tenant / actor / entity / action / time.
 *
 * Returns the same row shape as the tenant endpoint plus tenantId, so the
 * Admin UI can deep-link rows back into the tenant view.
 */

interface AdminAuditLogItem {
  id: string;
  tenantId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  /** Name of the event / venue / membership acted on; null for everything
   *  else, which has no name to show. */
  entityName: string | null;
  actorUserId: string | null;
  actorName: string | null;
  /** Phone or email of whoever acted, so a row is identifiable without an id. */
  actorContact: string | null;
  /** Owning organisation's name; null for platform-level entries. */
  tenantName: string | null;
  before: unknown;
  after: unknown;
  createdAt: string;
}

interface AdminAuditLogPage {
  rows: AdminAuditLogItem[];
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

const querySchema = z.object({
  /**
   * Free-text search so the log can be used without knowing any UUIDs: matches
   * an organisation's name or slug, a person's name, email or phone (whether
   * they acted or were acted upon), and the name of the event, venue or
   * membership that was acted on.
   */
  q: z.string().min(1).max(200).optional(),
  tenantId: z.string().uuid().optional(),
  actorUserId: z.string().uuid().optional(),
  entityType: z.string().min(1).max(100).optional(),
  entityId: z.string().uuid().optional(),
  action: z.string().min(1).max(200).optional(),
  since: z.string().datetime({ offset: true }).optional(),
  until: z.string().datetime({ offset: true }).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const adminAuditLogRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/admin/audit-log',
    { preHandler: requireAuth },
    async (req): Promise<AdminAuditLogPage> => {
      const user = await currentUser(req);
      const platformTenantId = await getPlatformTenantId();
      const ctx = await requireTenantMembership(user.id, platformTenantId);
      assertCap(ctx, 'admin.audit.read');

      const parsed = querySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new BadRequest('Invalid query parameters', 'bad_request', { issues: parsed.error.issues });
      }
      const p = parsed.data;
      const limit = Math.min(p.limit ?? 50, 200);
      const fetchLimit = limit + 1;

      const conditions: ReturnType<typeof sql>[] = [sql`1=1`];
      if (p.q) {
        const like = `%${p.q.toLowerCase().trim()}%`;
        // Phones are stored E.164; people type them with spaces, dashes or no
        // country code, so compare digits-only as well as the raw string.
        const digits = p.q.replace(/\D/g, '');
        const phoneLike = digits.length >= 4 ? `%${digits}%` : null;
        conditions.push(sql`(
          exists (
            select 1 from tenants tq
             where tq.id = al.tenant_id
               and (lower(tq.name) like ${like} or lower(tq.slug) like ${like})
          )
          or exists (
            select 1 from users uq
             where uq.id = al.actor_user_id
               and (lower(coalesce(uq.display_name, '')) like ${like}
                    or lower(coalesce(uq.email, '')) like ${like}
                    ${phoneLike ? sql`or regexp_replace(coalesce(uq.phone_e164, ''), '\\D', '', 'g') like ${phoneLike}` : sql``})
          )
          or exists (
            select 1 from events eq
             where eq.id = al.entity_id and al.entity_type = 'event'
               and lower(eq.name) like ${like}
          )
          or exists (
            select 1 from venues vq
             where vq.id = al.entity_id and al.entity_type = 'venue'
               and lower(vq.name) like ${like}
          )
          or exists (
            select 1 from memberships mq
             where mq.id = al.entity_id and al.entity_type = 'membership'
               and lower(mq.name) like ${like}
          )
          or exists (
            select 1 from users ue
             where ue.id = al.entity_id
               and (lower(coalesce(ue.display_name, '')) like ${like}
                    or lower(coalesce(ue.email, '')) like ${like}
                    ${phoneLike ? sql`or regexp_replace(coalesce(ue.phone_e164, ''), '\\D', '', 'g') like ${phoneLike}` : sql``})
          )
        )`);
      }
      if (p.tenantId)    conditions.push(sql`al.tenant_id     = ${p.tenantId}::uuid`);
      if (p.actorUserId) conditions.push(sql`al.actor_user_id = ${p.actorUserId}::uuid`);
      if (p.entityType)  conditions.push(sql`al.entity_type   = ${p.entityType}`);
      if (p.entityId)    conditions.push(sql`al.entity_id     = ${p.entityId}::uuid`);
      if (p.action)      conditions.push(sql`al.action        = ${p.action}`);
      if (p.since) {
        conditions.push(sql`al.created_at >= ${new Date(p.since).toISOString()}::timestamptz`);
      }
      if (p.until) {
        conditions.push(sql`al.created_at <  ${new Date(p.until).toISOString()}::timestamptz`);
      }
      if (p.cursor) {
        const decoded = decodeCursor(p.cursor);
        if (decoded) {
          conditions.push(
            sql`(al.created_at, al.id) < (${decoded.ts}::timestamptz, ${decoded.id}::uuid)`,
          );
        }
      }
      const whereClause = conditions.reduce((acc, c) => sql`${acc} AND ${c}`);

      const rawRows = await db.execute<Record<string, unknown>>(sql`
        SELECT
          al.id,
          al.tenant_id,
          al.action,
          al.entity_type,
          al.entity_id,
          -- Name of whatever the row acted on, for the three things partners
          -- actually name. Everything else (bookings, payments, slots) has no
          -- name to show and keeps its id.
          case al.entity_type
            when 'event'      then (select e2.name from events e2      where e2.id = al.entity_id)
            when 'venue'      then (select v2.name from venues v2      where v2.id = al.entity_id)
            when 'membership' then (select m2.name from memberships m2 where m2.id = al.entity_id)
          end AS entity_name,
          al.actor_user_id,
          u.display_name AS actor_name,
          coalesce(u.phone_e164, u.email) AS actor_contact,
          t.name AS tenant_name,
          al.before,
          al.after,
          al.created_at
        FROM audit_log al
        LEFT JOIN users u ON u.id = al.actor_user_id
        LEFT JOIN tenants t ON t.id = al.tenant_id
        WHERE ${whereClause}
        ORDER BY al.created_at DESC, al.id DESC
        LIMIT ${fetchLimit}
      `);

      const rows = rawRows as unknown as Record<string, unknown>[];
      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;

      const items: AdminAuditLogItem[] = pageRows.map((row) => ({
        id: row['id'] as string,
        tenantId: (row['tenant_id'] as string | null) ?? null,
        action: row['action'] as string,
        entityType: row['entity_type'] as string,
        entityId: (row['entity_id'] as string | null) ?? null,
        entityName: (row['entity_name'] as string | null) ?? null,
        actorUserId: (row['actor_user_id'] as string | null) ?? null,
        actorName: (row['actor_name'] as string | null) ?? null,
        actorContact: (row['actor_contact'] as string | null) ?? null,
        tenantName: (row['tenant_name'] as string | null) ?? null,
        before: row['before'] ?? null,
        after: row['after'] ?? null,
        createdAt: new Date(row['created_at'] as string).toISOString(),
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
};
