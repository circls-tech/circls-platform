/**
 * One-shot migration: take the comma-separated UUIDs that were in the legacy
 * PLATFORM_ADMIN_USER_IDS env, look up each `users` row, and INSERT a
 * tenant_members row into the Circls platform tenant with role='manager'
 * (so they retain admin-portal access via the new authz model).
 *
 * Usage:
 *   DATABASE_URL=… LEGACY_PLATFORM_ADMIN_USER_IDS=uuid1,uuid2 \
 *     pnpm migrate:platform-admins
 *
 * Idempotent: tenant_members has PK (user_id, tenant_id), and we use
 * onConflictDoNothing so re-running the script is safe.
 */
import { eq, inArray } from 'drizzle-orm';
import { closeDb, db } from '../src/db/client.js';
import { env } from '../src/config/env.js';
import { tenants } from '../src/db/schema/tenants.js';
import { tenantMembers } from '../src/db/schema/tenant_members.js';
import { users } from '../src/db/schema/users.js';
import { logger } from '../src/lib/logger.js';

async function main(): Promise<void> {
  const raw = process.env['LEGACY_PLATFORM_ADMIN_USER_IDS'];
  if (!raw) {
    process.stderr.write('LEGACY_PLATFORM_ADMIN_USER_IDS env var required\n');
    process.exit(1);
  }
  const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) {
    process.stderr.write('LEGACY_PLATFORM_ADMIN_USER_IDS contained no ids\n');
    process.exit(1);
  }

  const slug = process.env['CIRCLS_INTERNAL_TENANT_SLUG'] ?? env.CIRCLS_INTERNAL_TENANT_SLUG;
  const [tenant] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, slug))
    .limit(1);
  if (!tenant) {
    process.stderr.write(
      'Circls internal tenant not bootstrapped. Run bootstrap:circls first.\n',
    );
    process.exit(2);
  }

  const found = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(inArray(users.id, ids));
  if (found.length === 0) {
    process.stderr.write('No matching users found for those ids\n');
    process.exit(3);
  }

  for (const u of found) {
    await db
      .insert(tenantMembers)
      .values({ userId: u.id, tenantId: tenant.id, role: 'manager' })
      .onConflictDoNothing({ target: [tenantMembers.userId, tenantMembers.tenantId] });
    logger.info({ userId: u.id, email: u.email }, 'admin_migrated');
  }

  const missing = ids.filter((id) => !found.some((u) => u.id === id));
  if (missing.length > 0) {
    process.stdout.write(
      `Warning: ${missing.length} id(s) did not match any users row: ${missing.join(', ')}\n`,
    );
  }

  process.stdout.write(`Migrated ${found.length} platform admin(s) to the Circls tenant.\n`);
  await closeDb();
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'migration_failed');
  process.exit(1);
});
