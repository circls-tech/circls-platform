import { db } from '../db/client.js';
import { auditLog } from '../db/schema/index.js';

export interface AuditCtx {
  tenantId: string;
  actorUserId: string;
}

/**
 * Structural pick of just the `insert` method — satisfied by both `db` (PgDatabase)
 * and any drizzle transaction (PgTransaction extends PgDatabase).
 */
export type Inserter = Pick<typeof db, 'insert'>;

/** `exec` is the db or a transaction (pass the tx inside transactions). */
export async function writeAudit(
  exec: Inserter,
  ctx: AuditCtx,
  action: string,
  entityType: string,
  entityId: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): Promise<void> {
  await exec.insert(auditLog).values({
    tenantId: ctx.tenantId,
    actorUserId: ctx.actorUserId,
    action,
    entityType,
    entityId,
    before: before ?? undefined,
    after: after ?? undefined,
  });
}
