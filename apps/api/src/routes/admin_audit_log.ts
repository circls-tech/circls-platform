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
  actorUserId: string | null;
  actorName: string | null;
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
          al.actor_user_id,
          u.display_name AS actor_name,
          al.before,
          al.after,
          al.created_at
        FROM audit_log al
        LEFT JOIN users u ON u.id = al.actor_user_id
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
        actorUserId: (row['actor_user_id'] as string | null) ?? null,
        actorName: (row['actor_name'] as string | null) ?? null,
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
