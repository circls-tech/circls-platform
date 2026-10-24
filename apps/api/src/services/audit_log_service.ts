import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

export interface AuditLogItem {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  actorUserId: string | null;
  actorName: string | null;
  /**
   * The actor is on the Circls team and not a member of this org: a super
   * admin working in it, or an admin acting on it (say, reviewing a listing).
   */
  actorIsCircls: boolean;
  before: unknown;
  after: unknown;
  createdAt: string;
}

export interface AuditLogPage {
  rows: AuditLogItem[];
  nextCursor: string | null;
}

export interface AuditLogParams {
  from?: string;       // ISO datetime string (inclusive)
  to?: string;         // ISO datetime string (exclusive)
  action?: string;
  entityType?: string;
  cursor?: string;     // opaque: `${createdAtIso}|${id}`
  limit?: number;      // default 50, max 100
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

export async function listAuditLog(
  tenantId: string,
  params: AuditLogParams = {},
): Promise<AuditLogPage> {
  const limit = Math.min(params.limit ?? 50, 100);
  const fetchLimit = limit + 1; // fetch one extra to detect more pages

  // Build WHERE clauses incrementally using parameterized sql fragments.
  // drizzle `sql` tagged template deduplicates parameters correctly.
  const conditions: ReturnType<typeof sql>[] = [sql`al.tenant_id = ${tenantId}`];

  if (params.from) {
    conditions.push(sql`al.created_at >= ${new Date(params.from).toISOString()}::timestamptz`);
  }
  if (params.to) {
    conditions.push(sql`al.created_at < ${new Date(params.to).toISOString()}::timestamptz`);
  }
  if (params.action) {
    conditions.push(sql`al.action = ${params.action}`);
  }
  if (params.entityType) {
    conditions.push(sql`al.entity_type = ${params.entityType}`);
  }
  if (params.cursor) {
    const decoded = decodeCursor(params.cursor);
    if (decoded) {
      // Keyset pagination: rows strictly before (cursorTs, cursorId) in DESC order
      conditions.push(
        sql`(al.created_at, al.id) < (${decoded.ts}::timestamptz, ${decoded.id}::uuid)`,
      );
    }
  }

  // Join all conditions with AND
  const whereClause = conditions.reduce(
    (acc, cond) => sql`${acc} AND ${cond}`,
  );

  const rawRows = await db.execute<Record<string, unknown>>(sql`
    SELECT
      al.id,
      al.action,
      al.entity_type,
      al.entity_id,
      al.actor_user_id,
      u.display_name AS actor_name,
      (
        al.actor_user_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM tenant_members m
           WHERE m.tenant_id = al.tenant_id AND m.user_id = al.actor_user_id
        )
        AND EXISTS (
          SELECT 1 FROM tenant_members pm
            JOIN tenants pt ON pt.id = pm.tenant_id AND pt.is_platform
           WHERE pm.user_id = al.actor_user_id
        )
      ) AS actor_is_circls,
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

  const items: AuditLogItem[] = pageRows.map((row) => ({
    id: row['id'] as string,
    action: row['action'] as string,
    entityType: row['entity_type'] as string,
    entityId: (row['entity_id'] as string | null) ?? null,
    actorUserId: (row['actor_user_id'] as string | null) ?? null,
    actorName: (row['actor_name'] as string | null) ?? null,
    actorIsCircls: row['actor_is_circls'] === true,
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
}
