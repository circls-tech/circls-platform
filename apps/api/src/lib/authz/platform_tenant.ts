import { and, eq } from 'drizzle-orm';
import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import { tenants } from '../../db/schema/tenants.js';

let cachedId: string | null = null;

/**
 * Cached id of the Circls platform tenant. Looks up by the env-pinned slug
 * AND is_platform=true — both must match. The slug is human-readable for ops;
 * the boolean is what authz queries actually depend on.
 *
 * NOTE: We read the slug from process.env directly (falling back to the parsed
 * zod env) so that integration tests can override
 * `process.env.CIRCLS_INTERNAL_TENANT_SLUG` at runtime after module load.
 * Zod parses env at import time, so the parsed `env` value won't reflect
 * runtime mutations. This pattern matches the Phase 16 middleware precedent.
 */
export async function getPlatformTenantId(): Promise<string> {
  if (cachedId) return cachedId;
  const slug = process.env['CIRCLS_INTERNAL_TENANT_SLUG'] ?? env.CIRCLS_INTERNAL_TENANT_SLUG;
  const [row] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(and(eq(tenants.slug, slug), eq(tenants.isPlatform, true)))
    .limit(1);
  if (!row) {
    throw new Error(
      'circls_internal_tenant_not_bootstrapped — run scripts/bootstrap_circls_tenant.ts',
    );
  }
  cachedId = row.id;
  return row.id;
}

export function __resetPlatformTenantCacheForTesting(): void {
  cachedId = null;
}
