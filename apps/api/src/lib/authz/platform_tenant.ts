import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { tenants } from '../../db/schema/tenants.js';

let cachedId: string | null = null;

/**
 * Cached id of the Circls platform tenant (the row with `is_platform=true`).
 * Resolved once per process; safe because the row is stable in prod.
 *
 * For T8 we look up by is_platform=true directly. T9 will add an env-pinned
 * slug for ops clarity; the resolution logic stays the same (still just looks
 * for the is_platform=true row).
 */
export async function getPlatformTenantId(): Promise<string> {
  if (cachedId) return cachedId;
  const [row] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.isPlatform, true))
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
