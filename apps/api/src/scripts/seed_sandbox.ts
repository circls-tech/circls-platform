/**
 * Seeds the LOCAL SANDBOX only. Idempotent. Refuses to run unless the Firebase
 * Auth Emulator is configured (FIREBASE_AUTH_EMULATOR_HOST) — a guard so this
 * can never touch a real project or prod DB.
 *
 * Creates:
 *   - Auth Emulator users: an admin (custom claim admin:true), a partner phone
 *     user, a consumer phone user.
 *   - Postgres: the platform tenant + a demo venue tenant, plus users rows
 *     linked to the emulator UIDs.
 *
 * Run:  pnpm --filter @circls/api seed:sandbox
 */
import { eq } from 'drizzle-orm';
import { closeDb, db } from '../db/client.js';
import { env } from '../config/env.js';
import { firebaseAuth } from '../lib/firebase_admin.js';
import { tenants } from '../db/schema/tenants.js';
import { users } from '../db/schema/users.js';
import { logger } from '../lib/logger.js';

const DEMO = {
  admin: { uid: 'sandbox-admin', email: 'admin@sandbox.local', displayName: 'Sandbox Admin' },
  partner: { uid: 'sandbox-partner', phone: '+15555550101', email: 'partner@sandbox.local', displayName: 'Sandbox Partner' },
  consumer: { uid: 'sandbox-consumer', phone: '+15555550102', email: 'consumer@sandbox.local', displayName: 'Sandbox Consumer' },
};

async function ensureAuthUser(u: { uid: string; email?: string; phone?: string; displayName: string }): Promise<void> {
  const auth = firebaseAuth();
  try {
    await auth.getUser(u.uid);
    return; // already exists — idempotent
  } catch {
    /* create below */
  }
  await auth.createUser({
    uid: u.uid,
    ...(u.email ? { email: u.email, emailVerified: true } : {}),
    ...(u.phone ? { phoneNumber: u.phone } : {}),
    displayName: u.displayName,
  });
}

async function main(): Promise<void> {
  if (!env.FIREBASE_AUTH_EMULATOR_HOST) {
    process.stderr.write('Refusing to seed: FIREBASE_AUTH_EMULATOR_HOST is not set (sandbox only).\n');
    process.exit(1);
  }

  await ensureAuthUser(DEMO.admin);
  await ensureAuthUser(DEMO.partner);
  await ensureAuthUser(DEMO.consumer);
  await firebaseAuth().setCustomUserClaims(DEMO.admin.uid, { admin: true });

  const slug = env.CIRCLS_INTERNAL_TENANT_SLUG;
  const [platform] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, slug)).limit(1);
  if (!platform) {
    await db.insert(tenants).values({ slug, name: 'Circls', isPlatform: true, status: 'active' });
  }

  const demoSlug = 'demo-venue';
  const [demo] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, demoSlug)).limit(1);
  if (!demo) {
    await db.insert(tenants).values({ slug: demoSlug, name: 'Demo Venue Co', isPlatform: false, status: 'active' });
  }

  for (const u of [DEMO.admin, DEMO.partner, DEMO.consumer]) {
    const [row] = await db.select({ id: users.id }).from(users).where(eq(users.firebaseUid, u.uid)).limit(1);
    if (!row) {
      await db.insert(users).values({ firebaseUid: u.uid, email: u.email ?? `${u.uid}@sandbox.local`, displayName: u.displayName });
    }
  }

  logger.info('sandbox_seed_complete');
  process.stdout.write(
    'Sandbox seeded.\n' +
    '  Admin login (admin console):    admin@sandbox.local  (set any password via emulator; or use email-link)\n' +
    `  Partner login (partner portal): phone ${DEMO.partner.phone} — OTP shown in the emulator UI (localhost:4000) / logs\n` +
    `  Consumer login (consumer web):  phone ${DEMO.consumer.phone} — OTP shown in the emulator UI / logs\n`,
  );
  await closeDb();
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'sandbox_seed_failed');
  process.exit(1);
});
