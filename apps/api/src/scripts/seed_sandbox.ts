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
import { venues } from '../db/schema/venues.js';
import { events } from '../db/schema/events.js';
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

interface DemoVenue {
  name: string;
  addressJson: Record<string, unknown>;
  lat: number;
  lng: number;
  tzName: string;
  tags: string[];
}

/**
 * Get-or-create a venue by (tenant, name); on a match the location fields are
 * refreshed so re-runs converge (e.g. backfilling `country`). Returns its id.
 */
async function ensureVenue(tenantId: string, v: DemoVenue): Promise<string> {
  const [existing] = await db
    .select({ id: venues.id })
    .from(venues)
    .where(and(eq(venues.tenantId, tenantId), eq(venues.name, v.name)))
    .limit(1);
  if (existing) {
    await db
      .update(venues)
      .set({ addressJson: v.addressJson, lat: v.lat, lng: v.lng, tzName: v.tzName, tags: v.tags })
      .where(eq(venues.id, existing.id));
    return existing.id;
  }
  const [created] = await db
    .insert(venues)
    .values({
      tenantId,
      name: v.name,
      addressJson: v.addressJson,
      lat: v.lat,
      lng: v.lng,
      tzName: v.tzName,
      tags: v.tags,
      status: 'active',
    })
    .returning({ id: venues.id });
  if (!created) throw new Error(`venue insert returned no row for ${v.name}`);
  return created.id;
}

const DAY_MS = 24 * 60 * 60 * 1000;

interface DemoEvent {
  name: string;
  description: string;
  /** Days from now the event starts; runs for 2 hours. */
  startInDays: number;
  pricePaise: number;
  capacity: number;
  /** Venue-scoped: location is inherited. Standalone: provide `location`. */
  venueId?: string;
  location?: { addressJson: Record<string, unknown>; lat: number; lng: number; tzName: string };
}

/** Get-or-create a published event by (tenant, name). Idempotent; returns its id. */
async function ensureEvent(tenantId: string, e: DemoEvent): Promise<string> {
  const [existing] = await db
    .select({ id: events.id })
    .from(events)
    .where(and(eq(events.tenantId, tenantId), eq(events.name, e.name)))
    .limit(1);
  if (existing) return existing.id;
  const startsAt = new Date(Date.now() + e.startInDays * DAY_MS);
  const endsAt = new Date(startsAt.getTime() + 2 * 60 * 60 * 1000);
  // events_scope_chk: a venue event keeps location columns null; a standalone
  // event must carry its own address_json + tz_name (venue_id null).
  const [created] = await db
    .insert(events)
    .values({
      tenantId,
      venueId: e.venueId ?? null,
      ...(e.location
        ? {
            addressJson: e.location.addressJson,
            lat: e.location.lat,
            lng: e.location.lng,
            tzName: e.location.tzName,
          }
        : {}),
      name: e.name,
      description: e.description,
      startsAt,
      endsAt,
      pricePaise: e.pricePaise,
      capacity: e.capacity,
      status: 'published',
    })
    .returning({ id: events.id });
  if (!created) throw new Error(`event insert returned no row for ${e.name}`);
  return created.id;
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
  const platformTenantId = await ensureTenant(env.CIRCLS_INTERNAL_TENANT_SLUG, 'Circls', true);
  const demoTenantId = await ensureTenant('demo-venue', 'Demo Venue Co', false);

  // 3. Postgres users rows linked to the emulator UIDs.
  const adminUserId = await ensureUserRow(DEMO.admin);
  const partnerUserId = await ensureUserRow(DEMO.partner);
  await ensureUserRow(DEMO.consumer);

  // 4. Make the partner an owner of the demo tenant so the partner portal has a
  //    venue to act on (otherwise it lands on an empty onboarding state).
  await ensureMembership(partnerUserId, demoTenantId, 'owner');

  // 5. Make the admin an owner of the platform tenant. Admin routes (e.g.
  //    /v1/admin/stats) require platform-tenant membership with admin caps;
  //    the `admin:true` Firebase claim alone is not enough, so without this
  //    the admin console logs in then 403s and bounces the user out.
  await ensureMembership(adminUserId, platformTenantId, 'owner');

  // 5. Browse content for the consumer site, in two countries — the location
  //    filter shows venues by city and events by country, and the two markets
  //    don't overlap. India: a Bengaluru venue + event. USA: a standalone
  //    Boston event under its own org (no venue needed).
  const blrVenueId = await ensureVenue(demoTenantId, {
    name: 'Crimson Sports Hub',
    addressJson: { line1: 'MG Road', city: 'Bengaluru', country: 'India' },
    lat: 12.9905,
    lng: 77.6206,
    tzName: 'Asia/Kolkata',
    tags: ['football', 'outdoor'],
  });
  await ensureEvent(demoTenantId, {
    name: 'Sunday Football Meetup',
    description: 'Casual 5-a-side football at Crimson Sports Hub. All levels welcome.',
    startInDays: 7,
    pricePaise: 20_000,
    capacity: 20,
    venueId: blrVenueId,
  });

  const bostonTenantId = await ensureTenant('boston-sports', 'Boston Sports Collective', false);
  await ensureEvent(bostonTenantId, {
    name: 'Boston Pickup Basketball',
    description: 'Open-run pickup basketball in downtown Boston. Bring water.',
    startInDays: 7,
    pricePaise: 0,
    capacity: 24,
    location: {
      addressJson: { line1: '100 Legends Way', city: 'Boston', country: 'USA' },
      lat: 42.3662,
      lng: -71.0621,
      tzName: 'America/New_York',
    },
  });

  logger.info('sandbox_seed_complete');
  process.stdout.write(
    'Sandbox seeded. Demo logins:\n' +
    `  Admin console  (http://localhost:3002) — email ${DEMO.admin.email} / password ${PASSWORD}\n` +
    `  Partner portal (http://localhost:3001) — email ${DEMO.partner.email} / password ${PASSWORD}  (owner of "Demo Venue Co")\n` +
    `  Consumer web   (http://localhost:3003) — phone ${DEMO.consumer.phone}; OTP shown in the emulator UI (http://localhost:4000) / "./sandbox logs firebase-emulator"\n` +
    '  Browse content: Bengaluru venue + event (India) and a Boston event (USA) — the consumer location filter keeps them in separate countries.\n',
  );
  await closeDb();
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'sandbox_seed_failed');
  process.exit(1);
});
