/**
 * One-shot bootstrap of the Circls internal tenant + the founder's invitation.
 *
 * Usage:
 *   Dev:  DATABASE_URL=… pnpm bootstrap:circls vedant@gibbous.io "Vedant S"
 *   Prod: node dist/scripts/bootstrap_circls_tenant.js vedant@gibbous.io "Vedant S"
 *
 * Lives under src/ (not a top-level scripts/ dir) so `tsc` compiles it into
 * dist/scripts/ and `pnpm deploy --prod` ships it inside the runtime image —
 * making it runnable in the production container, which has only node + dist/.
 *
 * Prints the invite URL on success; the operator opens it on admin.circls.app,
 * sets a password, and becomes the owning Circls member. Idempotent: re-running
 * after success is a no-op.
 */
import { eq } from 'drizzle-orm';
import { closeDb, db } from '../db/client.js';
import { env } from '../config/env.js';
import { tenants } from '../db/schema/tenants.js';
import { users } from '../db/schema/users.js';
import { createInvitation } from '../services/invitation_service.js';
import { logger } from '../lib/logger.js';

async function main(): Promise<void> {
  const [, , emailArg, nameArg] = process.argv;
  if (!emailArg) {
    process.stderr.write('Usage: bootstrap:circls <founderEmail> [displayName]\n');
    process.exit(1);
  }
  const email = emailArg.toLowerCase();
  const displayName = nameArg ?? 'Founder';

  const slug = process.env['CIRCLS_INTERNAL_TENANT_SLUG'] ?? env.CIRCLS_INTERNAL_TENANT_SLUG;

  const [existing] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, slug))
    .limit(1);
  if (existing) {
    logger.info({ slug }, 'already_bootstrapped');
    process.stdout.write('Circls internal tenant already exists. No action taken.\n');
    await closeDb();
    return;
  }

  // Create the tenant + a bootstrap user (used as invited_by_user_id since no
  // founder user exists yet). The bootstrap user is a real users row tagged
  // with a recognisable firebase_uid; ops can clean it up later if desired.
  const seed = await db.transaction(async (tx) => {
    const [t] = await tx
      .insert(tenants)
      .values({
        slug,
        name: 'Circls',
        isPlatform: true,
        status: 'active',
      })
      .returning();
    if (!t) throw new Error('tenant insert returned no row');

    const [u] = await tx
      .insert(users)
      .values({
        firebaseUid: `bootstrap-${Date.now()}`,
        email: `bootstrap+${slug}@circls.app`,
        displayName: 'Bootstrap',
      })
      .returning();
    if (!u) throw new Error('bootstrap user insert returned no row');

    return { tenantId: t.id, bootstrapUserId: u.id };
  });

  // createInvitation opens its own audit + dispatch writes — runs outside the
  // tx so it can write its rows on the committed tenant.
  const inv = await createInvitation({
    tenantId: seed.tenantId,
    actorUserId: seed.bootstrapUserId,
    email,
    role: 'owner',
    ttlDays: 30, // founder may take longer than 7d to activate
  });

  const url = `${env.ADMIN_BASE_URL}/invite/${inv.plaintextToken}`;
  process.stdout.write(
    `Circls internal tenant bootstrapped.\n` +
    `Invitation for ${email} (${displayName}):\n\n` +
    `  ${url}\n\n` +
    `Expires: ${inv.invitation.expiresAt.toISOString()}\n`,
  );

  await closeDb();
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'bootstrap_failed');
  process.exit(1);
});
