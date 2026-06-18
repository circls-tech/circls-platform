/**
 * Seeds the LOCAL SANDBOX only. Idempotent. Refuses to run unless the Firebase
 * Auth Emulator is configured (FIREBASE_AUTH_EMULATOR_HOST) — a guard so this
 * can never touch a real project or prod DB.
 *
 * Identities match each portal's actual auth method:
 *   - Admin console (email/password)  → admin user + `admin:true` claim.
 *   - Partner portal (email/password) → partner user, owner of the demo tenant.
 *   - Consumer web (phone OTP)        → consumer phone user.
 *
 * Run:  pnpm --filter @circls/api seed:sandbox
 */
import { and, eq } from 'drizzle-orm';
import { closeDb, db } from '../db/client.js';
import { env } from '../config/env.js';
import { firebaseAuth } from '../lib/firebase_admin.js';
import { tenants } from '../db/schema/tenants.js';
import { tenantMembers } from '../db/schema/tenant_members.js';
import { users } from '../db/schema/users.js';
import { logger } from '../lib/logger.js';

const PASSWORD = 'sandbox123';
const DEMO = {
  admin: { uid: 'sandbox-admin', email: 'admin@sandbox.local', password: PASSWORD, displayName: 'Sandbox Admin' },
  partner: { uid: 'sandbox-partner', email: 'partner@sandbox.local', password: PASSWORD, displayName: 'Sandbox Partner' },
  consumer: { uid: 'sandbox-consumer', phone: '+15555550102', email: 'consumer@sandbox.local', displayName: 'Sandbox Consumer' },
};

interface DemoUser {
  uid: string;
  email?: string;
  phone?: string;
  password?: string;
  displayName: string;
}

async function ensureAuthUser(u: DemoUser): Promise<void> {
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
    ...(u.password ? { password: u.password } : {}),
    displayName: u.displayName,
  });
}

/** Get-or-create a tenant by slug; returns its id. Idempotent. */
async function ensureTenant(slug: string, name: string, isPlatform: boolean): Promise<string> {
  const [existing] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, slug)).limit(1);
  if (existing) return existing.id;
  const [created] = await db
    .insert(tenants)
    .values({ slug, name, isPlatform, status: 'active' })
    .returning({ id: tenants.id });
  if (!created) throw new Error(`tenant insert returned no row for ${slug}`);
  return created.id;
}

/** Get-or-create a users row by firebaseUid; returns its id. Idempotent. */
async function ensureUserRow(u: DemoUser): Promise<string> {
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.firebaseUid, u.uid)).limit(1);
  if (existing) return existing.id;
  const [created] = await db
    .insert(users)
    .values({ firebaseUid: u.uid, email: u.email ?? `${u.uid}@sandbox.local`, displayName: u.displayName })
    .returning({ id: users.id });
  if (!created) throw new Error(`user insert returned no row for ${u.uid}`);
  return created.id;
}

/** Link a user to a tenant in the given role. Idempotent on the (user, tenant) PK. */
async function ensureMembership(userId: string, tenantId: string, role: 'owner'): Promise<void> {
  const [existing] = await db
    .select({ userId: tenantMembers.userId })
    .from(tenantMembers)
    .where(and(eq(tenantMembers.userId, userId), eq(tenantMembers.tenantId, tenantId)))
    .limit(1);
  if (existing) return;
  await db.insert(tenantMembers).values({ userId, tenantId, role });
}

async function main(): Promise<void> {
  if (!env.FIREBASE_AUTH_EMULATOR_HOST) {
    process.stderr.write('Refusing to seed: FIREBASE_AUTH_EMULATOR_HOST is not set (sandbox only).\n');
    process.exit(1);
  }

  // 1. Emulator login users (matching each portal's auth method).
  await ensureAuthUser(DEMO.admin);
  await ensureAuthUser(DEMO.partner);
  await ensureAuthUser(DEMO.consumer);
  await firebaseAuth().setCustomUserClaims(DEMO.admin.uid, { admin: true });

  // 2. Tenants: the platform tenant + a demo venue tenant.
  await ensureTenant(env.CIRCLS_INTERNAL_TENANT_SLUG, 'Circls', true);
  const demoTenantId = await ensureTenant('demo-venue', 'Demo Venue Co', false);

  // 3. Postgres users rows linked to the emulator UIDs.
  await ensureUserRow(DEMO.admin);
  const partnerUserId = await ensureUserRow(DEMO.partner);
  await ensureUserRow(DEMO.consumer);

  // 4. Make the partner an owner of the demo tenant so the partner portal has a
  //    venue to act on (otherwise it lands on an empty onboarding state).
  await ensureMembership(partnerUserId, demoTenantId, 'owner');

  logger.info('sandbox_seed_complete');
  process.stdout.write(
    'Sandbox seeded. Demo logins:\n' +
    `  Admin console  (http://localhost:3002) — email ${DEMO.admin.email} / password ${PASSWORD}\n` +
    `  Partner portal (http://localhost:3001) — email ${DEMO.partner.email} / password ${PASSWORD}  (owner of "Demo Venue Co")\n` +
    `  Consumer web   (http://localhost:3003) — phone ${DEMO.consumer.phone}; OTP shown in the emulator UI (http://localhost:4000) / "./sandbox logs firebase-emulator"\n`,
  );
  await closeDb();
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'sandbox_seed_failed');
  process.exit(1);
});
