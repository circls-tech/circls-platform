import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * What one write request did that the audit trail cares about: the partner
 * orgs a Circls super admin got into through requireTenantMembership's
 * super-admin path, and the orgs the request already wrote an audit row for.
 * lib/super_admin_audit.ts reads it once the request succeeds, so every
 * change a super admin makes shows in the org's Activity Log — even where
 * the change itself isn't audited.
 *
 * Kept free of imports so lib/audit.ts and the tenancy guard can both use it.
 */
export interface RequestAuditContext {
  superAdminUserId: string | null;
  superAdminTenantIds: Set<string>;
  auditedTenantIds: Set<string>;
}

const storage = new AsyncLocalStorage<RequestAuditContext>();

export function newRequestAuditContext(): RequestAuditContext {
  return { superAdminUserId: null, superAdminTenantIds: new Set(), auditedTenantIds: new Set() };
}

/** Run the rest of a request with `ctx` as its audit context. */
export function runWithRequestAuditContext(ctx: RequestAuditContext, fn: () => void): void {
  storage.run(ctx, fn);
}

/** A super admin acted in `tenantId` without being its member. */
export function noteSuperAdminAccess(userId: string, tenantId: string): void {
  const ctx = storage.getStore();
  if (!ctx) return;
  ctx.superAdminUserId = userId;
  ctx.superAdminTenantIds.add(tenantId);
}

/** The request wrote an audit row for `tenantId`. */
export function noteAudited(tenantId: string): void {
  storage.getStore()?.auditedTenantIds.add(tenantId);
}
