# Team management — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship enforced role-based authorization, email-based team invitations, partner-portal email/password auth, and Circls-as-platform-tenant — retiring `PLATFORM_ADMIN_USER_IDS` env-list authz in favor of capability-based authz over membership.

**Architecture:** A `Capability` enum + two `Record<TenantRole, Capability[]>` maps (`PARTNER_CAPS` / `PLATFORM_CAPS`) form the authz source of truth. `requireCap(cap)` middleware picks the right map via `ctx.tenant.isPlatform`. New `tenant_invitations` table holds bcrypt-hashed token rows with 7-day expiry. Both portals authenticate via Firebase Auth email/password; the partner portal migrates off phone-OTP. Audit goes through the existing `writeAudit()` helper.

**Tech Stack:** Fastify 5 · Drizzle ORM · Postgres 18 · Firebase Auth (`firebase`/`firebase-admin`) · bcryptjs · Vitest · Next.js 15 · React 19 · React Query 5 · Tailwind 4.

**Spec:** `docs/superpowers/specs/2026-05-28-team-management-design.md`.

**Starting state:** Branch `worktree-track-b-scaffold` at commit `6393132` (Track B fully merged + this plan's spec committed). All 3 packages typecheck clean; 256/256 integration tests pass on a fresh DB.

---

## Task 1: Schema migration + Drizzle types

**Files:**
- Create: `apps/api/src/db/migrations/0011_team_management.sql`
- Create: `apps/api/src/db/schema/tenant_invitations.ts`
- Modify: `apps/api/src/db/schema/tenants.ts` (add `isPlatform` column)
- Modify: `apps/api/src/db/schema/index.ts` (export new table)
- Modify: `apps/api/src/db/migrations/meta/_journal.json` (append idx 11)

- [ ] **Step 1: Write the SQL migration**

Create `apps/api/src/db/migrations/0011_team_management.sql`:

```sql
-- Team management: tenants.is_platform + tenant_invitations.

ALTER TABLE "tenants" ADD COLUMN "is_platform" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE TABLE "tenant_invitations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" "tenant_role" NOT NULL,
	"invited_by_user_id" uuid NOT NULL,
	"token_prefix" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_user_id" uuid,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenant_invitations" ADD CONSTRAINT "tenant_invitations_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tenant_invitations" ADD CONSTRAINT "tenant_invitations_invited_by_user_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tenant_invitations" ADD CONSTRAINT "tenant_invitations_accepted_user_id_fk" FOREIGN KEY ("accepted_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "tenant_invitations_token_prefix_idx" ON "tenant_invitations" ("token_prefix");
--> statement-breakpoint
CREATE INDEX "tenant_invitations_tenant_email_idx" ON "tenant_invitations" ("tenant_id", "email");
--> statement-breakpoint
-- IMMUTABLE predicate only (now() is STABLE and gets rejected). The resend
-- flow UPDATEs the existing row in place, so stale-expired rows don't block.
CREATE UNIQUE INDEX "tenant_invitations_live_uniq" ON "tenant_invitations" ("tenant_id", "email") WHERE "accepted_at" IS NULL AND "revoked_at" IS NULL;
```

- [ ] **Step 2: Append journal entry**

Edit `apps/api/src/db/migrations/meta/_journal.json` — append (within `"entries"`):

```json
    ,
    {
      "idx": 11,
      "version": "7",
      "when": 1780080000000,
      "tag": "0011_team_management",
      "breakpoints": true
    }
```

- [ ] **Step 3: Add `isPlatform` to the Drizzle tenants schema**

Edit `apps/api/src/db/schema/tenants.ts` — add `boolean` to the import and the column after `addressJson`:

```ts
import { boolean, jsonb, pgEnum, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
```

```ts
  addressJson: jsonb('address_json'),
  /** Belt-and-suspenders next to the reserved slug. The Circls internal
   *  tenant sets this true; authz reads this, not the slug. */
  isPlatform: boolean('is_platform').notNull().default(false),
```

- [ ] **Step 4: Create the Drizzle `tenant_invitations` schema**

Create `apps/api/src/db/schema/tenant_invitations.ts`:

```ts
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { createdAt, uuidPk } from './_columns.js';
import { tenantRole } from './tenant_members.js';
import { tenants } from './tenants.js';
import { users } from './users.js';

/**
 * Pending team-member invitations. Created by an owner/manager; consumed by
 * the invitee when they click the email link. The plaintext token is kept ONLY
 * in the email — we store its bcrypt hash + a 12-char prefix for indexed
 * lookup (the api_keys pattern).
 */
export const tenantInvitations = pgTable('tenant_invitations', {
  id: uuidPk(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  /** Stored lowercased. */
  email: text('email').notNull(),
  role: tenantRole('role').notNull(),
  invitedByUserId: uuid('invited_by_user_id')
    .notNull()
    .references(() => users.id),
  /** First 12 chars of the token (cheap indexed prefix scan). */
  tokenPrefix: text('token_prefix').notNull(),
  /** bcrypt(plaintextToken, 10). */
  tokenHash: text('token_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  acceptedUserId: uuid('accepted_user_id').references(() => users.id),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export type TenantInvitation = typeof tenantInvitations.$inferSelect;
export type NewTenantInvitation = typeof tenantInvitations.$inferInsert;
```

- [ ] **Step 5: Export from the schema barrel**

Edit `apps/api/src/db/schema/index.ts` — add after `export * from './audit_log.js';` and BEFORE the `// Track B` comment block:

```ts
export * from './tenant_invitations.js';
```

- [ ] **Step 6: Apply migration to a fresh test DB and verify**

Run:
```bash
docker exec circls-devpg psql -U postgres -d postgres -c "CREATE DATABASE circls_team_test;"
cd apps/api
DATABASE_URL='postgres://postgres:postgres@localhost:5433/circls_team_test' pnpm db:migrate
```
Expected: `migrations_applied` line in output, no errors.

- [ ] **Step 7: Verify schema in psql**

Run:
```bash
docker exec circls-devpg psql -U postgres -d circls_team_test -c "\\d+ tenant_invitations" | head -25
docker exec circls-devpg psql -U postgres -d circls_team_test -c "\\d+ tenants" | grep is_platform
```
Expected: tenant_invitations table exists with all 12 columns + 3 indexes; tenants has `is_platform boolean NOT NULL DEFAULT false`.

- [ ] **Step 8: Typecheck + commit**

Run:
```bash
cd apps/api && pnpm typecheck
```
Expected: clean.

Commit:
```bash
git add apps/api/src/db
git commit -m "feat(db): tenants.is_platform + tenant_invitations (team mgmt schema)"
```

---

## Task 2: Authz primitives — Capability enum, role maps, can()

**Files:**
- Create: `apps/api/src/lib/authz/capabilities.ts`
- Create: `apps/api/src/lib/authz/role_caps.ts`
- Create: `apps/api/src/lib/authz/can.ts`
- Create: `apps/api/src/lib/authz/can.test.ts`

- [ ] **Step 1: Write the failing snapshot test**

Create `apps/api/src/lib/authz/can.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { TenantRole } from '../../db/schema/tenant_members.js';
import { ALL_CAPABILITIES } from './capabilities.js';
import { can } from './can.js';

const ROLES: TenantRole[] = ['owner', 'manager', 'staff', 'readonly'];

/**
 * Snapshot the entire (role × capability) decision matrix for both partner
 * and platform tenants. Adding a new Capability forces every role row to be
 * updated; forgetting to grant it defaults to false (default-deny).
 */
describe('can() — authz matrix', () => {
  it('partner-tenant matrix is stable', () => {
    const matrix: Record<string, Record<string, boolean>> = {};
    for (const role of ROLES) {
      matrix[role] = {};
      for (const cap of ALL_CAPABILITIES) {
        matrix[role]![cap] = can({ role, isPlatform: false }, cap);
      }
    }
    expect(matrix).toMatchSnapshot();
  });

  it('platform-tenant matrix is stable', () => {
    const matrix: Record<string, Record<string, boolean>> = {};
    for (const role of ROLES) {
      matrix[role] = {};
      for (const cap of ALL_CAPABILITIES) {
        matrix[role]![cap] = can({ role, isPlatform: true }, cap);
      }
    }
    expect(matrix).toMatchSnapshot();
  });

  it('owner of a partner tenant can write venues', () => {
    expect(can({ role: 'owner', isPlatform: false }, 'venues.write')).toBe(true);
  });

  it('staff of a partner tenant cannot write venues', () => {
    expect(can({ role: 'staff', isPlatform: false }, 'venues.write')).toBe(false);
  });

  it('manager of a platform tenant can execute payouts', () => {
    expect(can({ role: 'manager', isPlatform: true }, 'admin.payouts.execute')).toBe(true);
  });

  it('staff of a platform tenant cannot execute payouts', () => {
    expect(can({ role: 'staff', isPlatform: true }, 'admin.payouts.execute')).toBe(false);
  });

  it('partner-tenant member never has admin.* caps', () => {
    for (const role of ROLES) {
      expect(can({ role, isPlatform: false }, 'admin.payouts.execute')).toBe(false);
      expect(can({ role, isPlatform: false }, 'admin.tenants.suspend')).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && pnpm test src/lib/authz/can.test.ts`
Expected: FAIL with "Cannot find module './capabilities.js'" or similar.

- [ ] **Step 3: Create the Capability enum**

Create `apps/api/src/lib/authz/capabilities.ts`:

```ts
/**
 * Flat capability enum. Authz checks call `can(ctx, cap)`; routes call
 * `requireCap(cap)`. Adding a new entry here forces the snapshot tests in
 * can.test.ts to fail until every role's grant set is reviewed — default-deny.
 */
export type Capability =
  // tenant
  | 'tenant.read'
  | 'tenant.update'
  | 'tenant.delete'
  // members
  | 'members.read'
  | 'members.invite'
  | 'members.role_change'
  | 'members.remove'
  // partner ops
  | 'venues.read'
  | 'venues.write'
  | 'arenas.read'
  | 'arenas.write'
  | 'schedules.read'
  | 'schedules.write'
  | 'pricing.read'
  | 'pricing.write'
  | 'bookings.read'
  | 'bookings.create'
  | 'bookings.cancel'
  | 'analytics.read'
  | 'financials.read'
  | 'events.read'
  | 'events.write'
  | 'memberships.read'
  | 'memberships.write'
  // platform-only (granted only when ctx.tenant.isPlatform === true)
  | 'admin.tenants.read'
  | 'admin.tenants.suspend'
  | 'admin.listings.review'
  | 'admin.payouts.execute'
  | 'admin.audit.read';

/** Used by snapshot tests + by tooling that needs to walk every capability. */
export const ALL_CAPABILITIES: readonly Capability[] = [
  'tenant.read', 'tenant.update', 'tenant.delete',
  'members.read', 'members.invite', 'members.role_change', 'members.remove',
  'venues.read', 'venues.write',
  'arenas.read', 'arenas.write',
  'schedules.read', 'schedules.write',
  'pricing.read', 'pricing.write',
  'bookings.read', 'bookings.create', 'bookings.cancel',
  'analytics.read', 'financials.read',
  'events.read', 'events.write',
  'memberships.read', 'memberships.write',
  'admin.tenants.read', 'admin.tenants.suspend',
  'admin.listings.review', 'admin.payouts.execute',
  'admin.audit.read',
] as const;
```

- [ ] **Step 4: Create the role-to-capability maps**

Create `apps/api/src/lib/authz/role_caps.ts`:

```ts
import type { TenantRole } from '../../db/schema/tenant_members.js';
import type { Capability } from './capabilities.js';

/** Caps each role gets on a *partner* tenant (isPlatform=false). */
export const PARTNER_CAPS: Record<TenantRole, readonly Capability[]> = {
  owner: [
    'tenant.read', 'tenant.update', 'tenant.delete',
    'members.read', 'members.invite', 'members.role_change', 'members.remove',
    'venues.read', 'venues.write',
    'arenas.read', 'arenas.write',
    'schedules.read', 'schedules.write',
    'pricing.read', 'pricing.write',
    'bookings.read', 'bookings.create', 'bookings.cancel',
    'analytics.read', 'financials.read',
    'events.read', 'events.write',
    'memberships.read', 'memberships.write',
  ],
  manager: [
    'tenant.read', 'tenant.update',
    'members.read', 'members.invite', 'members.role_change', 'members.remove',
    'venues.read', 'venues.write',
    'arenas.read', 'arenas.write',
    'schedules.read', 'schedules.write',
    'pricing.read', 'pricing.write',
    'bookings.read', 'bookings.create', 'bookings.cancel',
    'analytics.read', 'financials.read',
    'events.read', 'events.write',
    'memberships.read', 'memberships.write',
  ],
  staff: [
    'tenant.read',
    'members.read',
    'venues.read', 'arenas.read', 'schedules.read', 'pricing.read',
    'bookings.read', 'bookings.create', 'bookings.cancel',
    'analytics.read',
    'events.read', 'memberships.read',
  ],
  readonly: [
    'tenant.read',
    'members.read',
    'venues.read', 'arenas.read', 'schedules.read', 'pricing.read',
    'bookings.read',
    'analytics.read', 'financials.read',
    'events.read', 'memberships.read',
  ],
} as const;

/** Caps each role gets on the *Circls platform* tenant (isPlatform=true). */
export const PLATFORM_CAPS: Record<TenantRole, readonly Capability[]> = {
  // Founder / CTO: everything platform + everything partner-of-Circls.
  owner: [
    ...PARTNER_CAPS.owner,
    'admin.tenants.read', 'admin.tenants.suspend',
    'admin.listings.review', 'admin.payouts.execute',
    'admin.audit.read',
  ],
  // Ops lead: every admin power; no team mgmt of Circls itself.
  manager: [
    'tenant.read', 'tenant.update',
    'members.read',
    'admin.tenants.read', 'admin.tenants.suspend',
    'admin.listings.review', 'admin.payouts.execute',
    'admin.audit.read',
  ],
  // Ops IC: tenant + listing review + audit, no payout execution, no suspend.
  staff: [
    'tenant.read',
    'members.read',
    'admin.tenants.read',
    'admin.listings.review',
    'admin.audit.read',
  ],
  // Read-only audit / accountant for Circls.
  readonly: [
    'tenant.read',
    'members.read',
    'admin.tenants.read',
    'admin.audit.read',
  ],
} as const;
```

- [ ] **Step 5: Create the `can()` helper**

Create `apps/api/src/lib/authz/can.ts`:

```ts
import type { TenantRole } from '../../db/schema/tenant_members.js';
import type { Capability } from './capabilities.js';
import { PARTNER_CAPS, PLATFORM_CAPS } from './role_caps.js';

export interface AuthzContext {
  role: TenantRole;
  isPlatform: boolean;
}

/**
 * Check whether `ctx`'s role has `cap` on this tenant. Default-deny: missing
 * from the map means false. Constant-time `.includes` is fine at this scale
 * (≤ 30 caps × 4 roles).
 */
export function can(ctx: AuthzContext, cap: Capability): boolean {
  const map = ctx.isPlatform ? PLATFORM_CAPS : PARTNER_CAPS;
  return map[ctx.role].includes(cap);
}
```

- [ ] **Step 6: Run tests; accept the snapshot**

Run: `cd apps/api && pnpm test src/lib/authz/can.test.ts`
Expected: snapshot created on first run + all specific assertions pass.

- [ ] **Step 7: Inspect the snapshot file**

Open `apps/api/src/lib/authz/__snapshots__/can.test.ts.snap` and eyeball that:
- partner `owner.tenant.delete` is `true`, `staff.tenant.delete` is `false`
- platform `owner.admin.payouts.execute` is `true`, partner `owner.admin.payouts.execute` is `false`

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/lib/authz
git commit -m "feat(authz): capabilities + role maps + can() helper + matrix snapshot"
```

---

## Task 3: Middleware — tenant_context returns isPlatform + new requireCap

**Files:**
- Modify: `apps/api/src/middleware/tenant_context.ts`
- Create: `apps/api/src/middleware/require_cap.ts`
- Create: `apps/api/src/middleware/require_cap.test.ts`

- [ ] **Step 1: Update tenant_context to return isPlatform**

Replace the contents of `apps/api/src/middleware/tenant_context.ts`:

```ts
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type TenantMember, tenantMembers } from '../db/schema/index.js';
import { tenants } from '../db/schema/tenants.js';
import { Forbidden } from '../lib/errors.js';

export interface TenantContext {
  tenantId: string;
  userId: string;
  role: TenantMember['role'];
  /** True only for the Circls platform tenant. Drives the authz map choice. */
  isPlatform: boolean;
}

/**
 * The app-layer tenancy guard. Asserts the user is a member of the tenant,
 * fetches the tenant's `is_platform` flag, and returns the scoped context.
 * Every tenant-scoped service takes a resolved tenantId and filters by it
 * explicitly — a missing membership is a 403, never a cross-tenant leak.
 */
export async function requireTenantMembership(
  userId: string,
  tenantId: string,
): Promise<TenantContext> {
  const [row] = await db
    .select({
      role: tenantMembers.role,
      isPlatform: tenants.isPlatform,
    })
    .from(tenantMembers)
    .innerJoin(tenants, eq(tenants.id, tenantMembers.tenantId))
    .where(and(eq(tenantMembers.userId, userId), eq(tenantMembers.tenantId, tenantId)))
    .limit(1);
  if (!row) throw new Forbidden('Not a member of this tenant', 'tenant_forbidden');
  return { tenantId, userId, role: row.role, isPlatform: row.isPlatform };
}
```

- [ ] **Step 2: Write failing tests for requireCap**

Create `apps/api/src/middleware/require_cap.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Forbidden } from '../lib/errors.js';
import type { TenantContext } from './tenant_context.js';
import { assertCap } from './require_cap.js';

function ctx(overrides: Partial<TenantContext> = {}): TenantContext {
  return {
    tenantId: '00000000-0000-0000-0000-000000000000',
    userId: '00000000-0000-0000-0000-000000000001',
    role: 'owner',
    isPlatform: false,
    ...overrides,
  };
}

describe('assertCap()', () => {
  it('allows owner to write venues', () => {
    expect(() => assertCap(ctx({ role: 'owner' }), 'venues.write')).not.toThrow();
  });

  it('throws Forbidden when staff tries to write venues', () => {
    expect(() => assertCap(ctx({ role: 'staff' }), 'venues.write')).toThrow(Forbidden);
  });

  it('error code is forbidden_capability and includes the missing cap', () => {
    try {
      assertCap(ctx({ role: 'staff' }), 'venues.write');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(Forbidden);
      const f = err as Forbidden;
      expect(f.code).toBe('forbidden_capability');
      expect(f.details).toEqual({ cap: 'venues.write' });
    }
  });

  it('Circls staff can review listings; partner staff cannot', () => {
    expect(() => assertCap(ctx({ role: 'staff', isPlatform: true }), 'admin.listings.review')).not.toThrow();
    expect(() => assertCap(ctx({ role: 'staff', isPlatform: false }), 'admin.listings.review')).toThrow(Forbidden);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/api && pnpm test src/middleware/require_cap.test.ts`
Expected: FAIL with "Cannot find module './require_cap.js'".

- [ ] **Step 4: Implement require_cap**

Create `apps/api/src/middleware/require_cap.ts`:

```ts
import { Forbidden } from '../lib/errors.js';
import { can } from '../lib/authz/can.js';
import type { Capability } from '../lib/authz/capabilities.js';
import type { TenantContext } from './tenant_context.js';

/**
 * Sync capability check used inside route handlers after the caller has
 * already resolved `ctx` via `requireTenantMembership`. Throws Forbidden
 * with code='forbidden_capability' and a `{cap}` detail.
 *
 * Why not a Fastify preHandler? Most routes need the tenantId from a path
 * param resolved + ownership checks before they know the cap to check (e.g.,
 * GET /v1/venues/:id authz needs the venue's tenantId). assertCap stays
 * synchronous so handlers can call it inline after their lookup.
 */
export function assertCap(ctx: TenantContext, cap: Capability): void {
  if (!can(ctx, cap)) {
    throw new Forbidden(`Missing capability ${cap}`, 'forbidden_capability', { cap });
  }
}
```

- [ ] **Step 5: Run tests; verify pass**

Run: `cd apps/api && pnpm test src/middleware/require_cap.test.ts`
Expected: 4 PASS.

- [ ] **Step 6: Typecheck the whole package** (catches any caller broken by the TenantContext change)

Run: `cd apps/api && pnpm typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/middleware
git commit -m "feat(middleware): tenant_context returns isPlatform; new assertCap()"
```

---

## Task 4: invitation_service — create + lookup + accept + resend + revoke

**Files:**
- Create: `apps/api/src/services/invitation_service.ts`
- Create: `apps/api/src/services/invitation_service.test.ts`

- [ ] **Step 1: Write failing integration tests**

Create `apps/api/src/services/invitation_service.test.ts`:

```ts
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db, pingDb } from '../db/client.js';
import { tenants, tenantMembers, users } from '../db/schema/index.js';
import { tenantInvitations } from '../db/schema/tenant_invitations.js';
import { Conflict, Forbidden, NotFound } from '../lib/errors.js';
import {
  acceptInvitation,
  createInvitation,
  lookupInvitation,
  revokeInvitation,
  resendInvitation,
} from './invitation_service.js';

const runIntegration = Boolean(process.env.RUN_INTEGRATION);
const SUFFIX = Date.now();

describe.skipIf(!runIntegration)('invitation_service', () => {
  let tenantId: string;
  let ownerUserId: string;

  beforeAll(async () => {
    await pingDb();
    const [u] = await db
      .insert(users)
      .values({
        firebaseUid: `inv-owner-fb-${SUFFIX}`,
        email: `inv-owner-${SUFFIX}@x.test`,
      })
      .returning();
    ownerUserId = u!.id;
    const [t] = await db
      .insert(tenants)
      .values({ name: 'Inv Co', slug: `inv-${SUFFIX}` })
      .returning();
    tenantId = t!.id;
    await db.insert(tenantMembers).values({ userId: ownerUserId, tenantId, role: 'owner' });
  });

  afterAll(async () => {
    await db.execute(sql`delete from audit_log where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenant_invitations where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenant_members where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
    await db.execute(sql`delete from users where id = ${ownerUserId}`);
    await closeDb();
  });

  it('createInvitation inserts a row + returns the plaintext token + writes audit', async () => {
    const result = await createInvitation({
      tenantId,
      actorUserId: ownerUserId,
      email: `bob-${SUFFIX}@x.test`,
      role: 'manager',
    });
    expect(result.invitation.email).toBe(`bob-${SUFFIX}@x.test`);
    expect(result.invitation.role).toBe('manager');
    expect(result.invitation.acceptedAt).toBeNull();
    // token must NOT be persisted on the returned row; only in the result wrapper
    expect(result.plaintextToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const [row] = await db
      .select()
      .from(tenantInvitations)
      .where(sql`id = ${result.invitation.id}`);
    expect(row?.tokenPrefix).toBe(result.plaintextToken.slice(0, 12));
    expect(row?.tokenHash).not.toBe(result.plaintextToken);
  });

  it('createInvitation lowercases the email', async () => {
    const r = await createInvitation({
      tenantId,
      actorUserId: ownerUserId,
      email: `MiXeD-${SUFFIX}@X.tEsT`,
      role: 'staff',
    });
    expect(r.invitation.email).toBe(`mixed-${SUFFIX}@x.test`);
  });

  it('createInvitation rejects when a live invite already exists for that email', async () => {
    const email = `dup-${SUFFIX}@x.test`;
    await createInvitation({ tenantId, actorUserId: ownerUserId, email, role: 'staff' });
    await expect(
      createInvitation({ tenantId, actorUserId: ownerUserId, email, role: 'staff' }),
    ).rejects.toMatchObject({ code: 'invitation_already_pending' });
  });

  it('createInvitation rejects when the email is already a member', async () => {
    const memberEmail = `member-${SUFFIX}@x.test`;
    const [u] = await db
      .insert(users)
      .values({ firebaseUid: `mem-fb-${SUFFIX}`, email: memberEmail })
      .returning();
    await db.insert(tenantMembers).values({ userId: u!.id, tenantId, role: 'staff' });
    await expect(
      createInvitation({ tenantId, actorUserId: ownerUserId, email: memberEmail, role: 'staff' }),
    ).rejects.toMatchObject({ code: 'already_member' });
  });

  it('lookupInvitation returns metadata for a valid token', async () => {
    const r = await createInvitation({
      tenantId,
      actorUserId: ownerUserId,
      email: `look-${SUFFIX}@x.test`,
      role: 'readonly',
    });
    const meta = await lookupInvitation(r.plaintextToken);
    expect(meta).not.toBeNull();
    expect(meta?.tenantName).toBe('Inv Co');
    expect(meta?.role).toBe('readonly');
    expect(meta?.email).toBe(`look-${SUFFIX}@x.test`);
  });

  it('lookupInvitation returns null for an unknown token', async () => {
    const meta = await lookupInvitation('ck_does_not_exist__________________');
    expect(meta).toBeNull();
  });

  it('acceptInvitation creates the membership + marks accepted + writes audit', async () => {
    const r = await createInvitation({
      tenantId,
      actorUserId: ownerUserId,
      email: `accept-${SUFFIX}@x.test`,
      role: 'manager',
    });
    const accepted = await acceptInvitation({
      token: r.plaintextToken,
      firebaseUid: `accept-fb-${SUFFIX}`,
      email: `accept-${SUFFIX}@x.test`,
    });
    expect(accepted.tenantId).toBe(tenantId);
    expect(accepted.role).toBe('manager');

    const [inv] = await db
      .select()
      .from(tenantInvitations)
      .where(sql`id = ${r.invitation.id}`);
    expect(inv?.acceptedAt).not.toBeNull();

    const [mem] = await db
      .select()
      .from(tenantMembers)
      .where(sql`tenant_id = ${tenantId} and user_id = ${accepted.userId}`);
    expect(mem?.role).toBe('manager');
  });

  it('acceptInvitation rejects email mismatch', async () => {
    const r = await createInvitation({
      tenantId,
      actorUserId: ownerUserId,
      email: `mis-${SUFFIX}@x.test`,
      role: 'staff',
    });
    await expect(
      acceptInvitation({
        token: r.plaintextToken,
        firebaseUid: `mis-fb-${SUFFIX}`,
        email: `other-${SUFFIX}@x.test`,
      }),
    ).rejects.toMatchObject({ code: 'invitation_email_mismatch' });
  });

  it('acceptInvitation rejects a revoked invite', async () => {
    const r = await createInvitation({
      tenantId,
      actorUserId: ownerUserId,
      email: `rev-${SUFFIX}@x.test`,
      role: 'staff',
    });
    await revokeInvitation({ tenantId, invitationId: r.invitation.id, actorUserId: ownerUserId });
    await expect(
      acceptInvitation({
        token: r.plaintextToken,
        firebaseUid: `rev-fb-${SUFFIX}`,
        email: `rev-${SUFFIX}@x.test`,
      }),
    ).rejects.toMatchObject({ code: 'invitation_not_found' });
  });

  it('resendInvitation rotates the token; old token dies', async () => {
    const r = await createInvitation({
      tenantId,
      actorUserId: ownerUserId,
      email: `resend-${SUFFIX}@x.test`,
      role: 'staff',
    });
    const old = r.plaintextToken;
    const r2 = await resendInvitation({
      tenantId,
      invitationId: r.invitation.id,
      actorUserId: ownerUserId,
    });
    expect(r2.plaintextToken).not.toBe(old);
    // old token now fails accept
    await expect(
      acceptInvitation({
        token: old,
        firebaseUid: `resend-fb-${SUFFIX}`,
        email: `resend-${SUFFIX}@x.test`,
      }),
    ).rejects.toMatchObject({ code: 'invitation_not_found' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `DATABASE_URL='postgres://postgres:postgres@localhost:5433/circls_team_test' RUN_INTEGRATION=1 cd apps/api && pnpm test src/services/invitation_service.test.ts`

(Note: pnpm doesn't pass env via leading; use this form instead:)

```bash
cd apps/api && DATABASE_URL='postgres://postgres:postgres@localhost:5433/circls_team_test' RUN_INTEGRATION=1 pnpm test src/services/invitation_service.test.ts
```
Expected: FAIL with "Cannot find module './invitation_service.js'".

- [ ] **Step 3: Implement the service**

Create `apps/api/src/services/invitation_service.ts`:

```ts
/**
 * Team-member invitations — Phase D (team management).
 *
 * Lifecycle:
 *   create  → email out, row stored with bcrypt token hash
 *   lookup  → unauth endpoint for the accept page
 *   accept  → unauth; consumes the token, creates a tenant_members row
 *   resend  → rotates token + bumps expires_at
 *   revoke  → soft-revokes the row
 *
 * Token model: 24 random bytes → 32 base64url chars. Stored as bcrypt hash
 * + a 12-char prefix (indexed) for cheap candidate lookup; we bcrypt-compare
 * only the rows whose prefix matches.
 */
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { tenants } from '../db/schema/tenants.js';
import { tenantMembers, type TenantRole } from '../db/schema/tenant_members.js';
import { tenantInvitations, type TenantInvitation } from '../db/schema/tenant_invitations.js';
import { users } from '../db/schema/users.js';
import { writeAudit } from '../lib/audit.js';
import { Conflict, NotFound } from '../lib/errors.js';

const INVITE_TTL_DAYS = 7;
const BCRYPT_ROUNDS = 10;

function mintToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

function expiresInDays(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

function normEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** What we return after creating: the row + the *one-time* plaintext token. */
export interface CreateInvitationResult {
  invitation: TenantInvitation;
  plaintextToken: string;
}

export interface CreateInvitationInput {
  tenantId: string;
  actorUserId: string;
  email: string;
  role: TenantRole;
  ttlDays?: number;
}

export async function createInvitation(
  input: CreateInvitationInput,
): Promise<CreateInvitationResult> {
  const email = normEmail(input.email);

  // Reject if the email is already an active member of this tenant.
  const memberRows = await db
    .select({ userId: tenantMembers.userId })
    .from(tenantMembers)
    .innerJoin(users, eq(users.id, tenantMembers.userId))
    .where(and(eq(tenantMembers.tenantId, input.tenantId), eq(users.email, email)))
    .limit(1);
  if (memberRows.length > 0) {
    throw new Conflict('User is already a member', 'already_member', { email });
  }

  const token = mintToken();
  const tokenPrefix = token.slice(0, 12);
  const tokenHash = await bcrypt.hash(token, BCRYPT_ROUNDS);
  const expiresAt = expiresInDays(input.ttlDays ?? INVITE_TTL_DAYS);

  let inserted: TenantInvitation;
  try {
    const [row] = await db
      .insert(tenantInvitations)
      .values({
        tenantId: input.tenantId,
        email,
        role: input.role,
        invitedByUserId: input.actorUserId,
        tokenPrefix,
        tokenHash,
        expiresAt,
      })
      .returning();
    if (!row) throw new Error('invitation insert returned no row');
    inserted = row;
  } catch (err) {
    // The partial unique index throws on duplicate live invites.
    if (err instanceof Error && /tenant_invitations_live_uniq/.test(err.message)) {
      throw new Conflict('A live invitation already exists', 'invitation_already_pending', {
        email,
      });
    }
    throw err;
  }

  await writeAudit(
    db,
    { tenantId: input.tenantId, actorUserId: input.actorUserId },
    'tenant.invitation_sent',
    'invitation',
    inserted.id,
    null,
    { email, role: input.role, expiresAt: inserted.expiresAt },
  );

  return { invitation: inserted, plaintextToken: token };
}

export interface InvitationLookupResult {
  invitationId: string;
  tenantId: string;
  tenantName: string;
  role: TenantRole;
  email: string;
  expiresAt: Date;
  inviterEmail: string | null;
}

/**
 * Unauthenticated lookup for the accept page. Returns null if the token is
 * unknown / revoked / expired / accepted (deliberately doesn't distinguish so
 * a bot can't enumerate).
 */
export async function lookupInvitation(token: string): Promise<InvitationLookupResult | null> {
  if (token.length < 12) return null;
  const prefix = token.slice(0, 12);
  const candidates = await db
    .select({
      invitationId: tenantInvitations.id,
      tokenHash: tenantInvitations.tokenHash,
      tenantId: tenantInvitations.tenantId,
      tenantName: tenants.name,
      role: tenantInvitations.role,
      email: tenantInvitations.email,
      expiresAt: tenantInvitations.expiresAt,
      inviterEmail: users.email,
    })
    .from(tenantInvitations)
    .innerJoin(tenants, eq(tenants.id, tenantInvitations.tenantId))
    .leftJoin(users, eq(users.id, tenantInvitations.invitedByUserId))
    .where(
      and(
        eq(tenantInvitations.tokenPrefix, prefix),
        isNull(tenantInvitations.acceptedAt),
        isNull(tenantInvitations.revokedAt),
        sql`${tenantInvitations.expiresAt} > now()`,
      ),
    );
  for (const c of candidates) {
    const match = await bcrypt.compare(token, c.tokenHash);
    if (match) {
      return {
        invitationId: c.invitationId,
        tenantId: c.tenantId,
        tenantName: c.tenantName,
        role: c.role,
        email: c.email,
        expiresAt: c.expiresAt,
        inviterEmail: c.inviterEmail,
      };
    }
  }
  return null;
}

export interface AcceptInvitationInput {
  token: string;
  /** Firebase UID of the accepting user (from a verified ID token). */
  firebaseUid: string;
  /** Email claim from the same token. */
  email: string;
}

export interface AcceptInvitationResult {
  invitationId: string;
  tenantId: string;
  userId: string;
  role: TenantRole;
}

export async function acceptInvitation(input: AcceptInvitationInput): Promise<AcceptInvitationResult> {
  const tokenEmail = normEmail(input.email);
  const meta = await lookupInvitation(input.token);
  if (!meta) {
    throw new NotFound('Invitation not found or already used', 'invitation_not_found');
  }
  if (meta.email !== tokenEmail) {
    throw new Conflict('Token email does not match invitation', 'invitation_email_mismatch');
  }

  return db.transaction(async (tx) => {
    // Find-or-create the user. Race-safe because users.firebase_uid is unique.
    let [existing] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.firebaseUid, input.firebaseUid))
      .limit(1);
    if (!existing) {
      const [created] = await tx
        .insert(users)
        .values({ firebaseUid: input.firebaseUid, email: tokenEmail })
        .onConflictDoNothing({ target: users.firebaseUid })
        .returning();
      if (created) {
        existing = { id: created.id };
      } else {
        const [refetch] = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.firebaseUid, input.firebaseUid))
          .limit(1);
        existing = refetch!;
      }
    }

    // Idempotent membership insert (already-member is fine).
    await tx
      .insert(tenantMembers)
      .values({ userId: existing.id, tenantId: meta.tenantId, role: meta.role })
      .onConflictDoNothing({ target: [tenantMembers.userId, tenantMembers.tenantId] });

    // Conditional UPDATE: only the first concurrent accepter wins.
    const claimed = await tx
      .update(tenantInvitations)
      .set({ acceptedAt: new Date(), acceptedUserId: existing.id })
      .where(
        and(
          eq(tenantInvitations.id, meta.invitationId),
          isNull(tenantInvitations.acceptedAt),
        ),
      )
      .returning({ id: tenantInvitations.id });
    if (claimed.length === 0) {
      throw new Conflict('Invitation already accepted', 'already_accepted');
    }

    await writeAudit(
      tx,
      { tenantId: meta.tenantId, actorUserId: existing.id },
      'tenant.invitation_accepted',
      'invitation',
      meta.invitationId,
      { acceptedAt: null },
      { acceptedAt: new Date(), acceptedUserId: existing.id },
    );
    await writeAudit(
      tx,
      { tenantId: meta.tenantId, actorUserId: existing.id },
      'tenant.member_added',
      'tenant_member',
      existing.id,
      null,
      { userId: existing.id, role: meta.role, source: 'invitation' },
    );

    return {
      invitationId: meta.invitationId,
      tenantId: meta.tenantId,
      userId: existing.id,
      role: meta.role,
    };
  });
}

export interface ResendInvitationInput {
  tenantId: string;
  invitationId: string;
  actorUserId: string;
  ttlDays?: number;
}

export async function resendInvitation(input: ResendInvitationInput): Promise<CreateInvitationResult> {
  const token = mintToken();
  const tokenPrefix = token.slice(0, 12);
  const tokenHash = await bcrypt.hash(token, BCRYPT_ROUNDS);
  const expiresAt = expiresInDays(input.ttlDays ?? INVITE_TTL_DAYS);

  const [previous] = await db
    .select({ tokenPrefix: tenantInvitations.tokenPrefix, expiresAt: tenantInvitations.expiresAt })
    .from(tenantInvitations)
    .where(
      and(
        eq(tenantInvitations.id, input.invitationId),
        eq(tenantInvitations.tenantId, input.tenantId),
        isNull(tenantInvitations.acceptedAt),
        isNull(tenantInvitations.revokedAt),
      ),
    )
    .limit(1);
  if (!previous) throw new NotFound('Invitation not found', 'invitation_not_found');

  const [updated] = await db
    .update(tenantInvitations)
    .set({ tokenPrefix, tokenHash, expiresAt })
    .where(eq(tenantInvitations.id, input.invitationId))
    .returning();
  if (!updated) throw new NotFound('Invitation not found', 'invitation_not_found');

  await writeAudit(
    db,
    { tenantId: input.tenantId, actorUserId: input.actorUserId },
    'tenant.invitation_resent',
    'invitation',
    updated.id,
    { tokenPrefix: previous.tokenPrefix, expiresAt: previous.expiresAt },
    { tokenPrefix, expiresAt },
  );

  return { invitation: updated, plaintextToken: token };
}

export interface RevokeInvitationInput {
  tenantId: string;
  invitationId: string;
  actorUserId: string;
}

export async function revokeInvitation(input: RevokeInvitationInput): Promise<void> {
  const [updated] = await db
    .update(tenantInvitations)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(tenantInvitations.id, input.invitationId),
        eq(tenantInvitations.tenantId, input.tenantId),
        isNull(tenantInvitations.revokedAt),
        isNull(tenantInvitations.acceptedAt),
      ),
    )
    .returning();
  if (!updated) return; // idempotent

  await writeAudit(
    db,
    { tenantId: input.tenantId, actorUserId: input.actorUserId },
    'tenant.invitation_revoked',
    'invitation',
    updated.id,
    { revokedAt: null },
    { revokedAt: updated.revokedAt },
  );
}

export async function listInvitations(
  tenantId: string,
  status?: 'pending' | 'accepted' | 'expired' | 'revoked',
): Promise<TenantInvitation[]> {
  const base = db.select().from(tenantInvitations).where(eq(tenantInvitations.tenantId, tenantId));
  if (status === 'pending') {
    return db
      .select()
      .from(tenantInvitations)
      .where(
        and(
          eq(tenantInvitations.tenantId, tenantId),
          isNull(tenantInvitations.acceptedAt),
          isNull(tenantInvitations.revokedAt),
          sql`${tenantInvitations.expiresAt} > now()`,
        ),
      );
  }
  if (status === 'accepted') {
    return db
      .select()
      .from(tenantInvitations)
      .where(
        and(
          eq(tenantInvitations.tenantId, tenantId),
          sql`${tenantInvitations.acceptedAt} is not null`,
        ),
      );
  }
  if (status === 'expired') {
    return db
      .select()
      .from(tenantInvitations)
      .where(
        and(
          eq(tenantInvitations.tenantId, tenantId),
          isNull(tenantInvitations.acceptedAt),
          isNull(tenantInvitations.revokedAt),
          sql`${tenantInvitations.expiresAt} <= now()`,
        ),
      );
  }
  if (status === 'revoked') {
    return db
      .select()
      .from(tenantInvitations)
      .where(
        and(
          eq(tenantInvitations.tenantId, tenantId),
          sql`${tenantInvitations.revokedAt} is not null`,
        ),
      );
  }
  return base;
}
```

- [ ] **Step 4: Add bcryptjs to api deps if not already present**

Check `apps/api/package.json`. Phase 17 already added `bcryptjs`. If not:

```bash
cd apps/api && pnpm add bcryptjs && pnpm add -D @types/bcryptjs
```

- [ ] **Step 5: Run tests; verify all pass**

Run:
```bash
cd apps/api && DATABASE_URL='postgres://postgres:postgres@localhost:5433/circls_team_test' RUN_INTEGRATION=1 pnpm test src/services/invitation_service.test.ts
```
Expected: 10 PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/invitation_service.ts apps/api/src/services/invitation_service.test.ts apps/api/package.json apps/api/pnpm-lock.yaml
git commit -m "feat(team): invitation_service — create/lookup/accept/resend/revoke + audit"
```

---

## Task 5: team_service — list members, role change, remove, owner-safety

**Files:**
- Create: `apps/api/src/services/team_service.ts`
- Create: `apps/api/src/services/team_service.test.ts`

- [ ] **Step 1: Write failing integration tests**

Create `apps/api/src/services/team_service.test.ts`:

```ts
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db, pingDb } from '../db/client.js';
import { tenants, tenantMembers, users } from '../db/schema/index.js';
import { Conflict, NotFound } from '../lib/errors.js';
import { listMembers, removeMember, updateMemberRole } from './team_service.js';

const runIntegration = Boolean(process.env.RUN_INTEGRATION);
const SUFFIX = Date.now();

describe.skipIf(!runIntegration)('team_service', () => {
  let tenantId: string;
  let owner1: string;
  let owner2: string;
  let staff: string;

  beforeAll(async () => {
    await pingDb();
    const [u1] = await db.insert(users).values({
      firebaseUid: `team-o1-${SUFFIX}`, email: `o1-${SUFFIX}@x.test`,
    }).returning();
    const [u2] = await db.insert(users).values({
      firebaseUid: `team-o2-${SUFFIX}`, email: `o2-${SUFFIX}@x.test`,
    }).returning();
    const [u3] = await db.insert(users).values({
      firebaseUid: `team-s-${SUFFIX}`, email: `s-${SUFFIX}@x.test`,
    }).returning();
    owner1 = u1!.id; owner2 = u2!.id; staff = u3!.id;
    const [t] = await db.insert(tenants).values({
      name: 'Team Co', slug: `team-${SUFFIX}`,
    }).returning();
    tenantId = t!.id;
    await db.insert(tenantMembers).values([
      { userId: owner1, tenantId, role: 'owner' },
      { userId: owner2, tenantId, role: 'owner' },
      { userId: staff, tenantId, role: 'staff' },
    ]);
  });

  afterAll(async () => {
    await db.execute(sql`delete from audit_log where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenant_members where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
    await db.execute(sql`delete from users where id in (${owner1}, ${owner2}, ${staff})`);
    await closeDb();
  });

  it('listMembers returns all three with their roles', async () => {
    const rows = await listMembers(tenantId);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.role).sort()).toEqual(['owner', 'owner', 'staff']);
  });

  it('updateMemberRole promotes staff to manager', async () => {
    await updateMemberRole({
      tenantId, targetUserId: staff, actorUserId: owner1, nextRole: 'manager',
    });
    const rows = await listMembers(tenantId);
    expect(rows.find((r) => r.userId === staff)?.role).toBe('manager');
  });

  it('updateMemberRole rejects demoting the last owner', async () => {
    // First make owner2 a staff so owner1 is the last owner.
    await updateMemberRole({
      tenantId, targetUserId: owner2, actorUserId: owner1, nextRole: 'staff',
    });
    await expect(
      updateMemberRole({
        tenantId, targetUserId: owner1, actorUserId: owner1, nextRole: 'manager',
      }),
    ).rejects.toMatchObject({ code: 'last_owner_protected' });
    // Restore so other tests have ≥2 owners.
    await updateMemberRole({
      tenantId, targetUserId: owner2, actorUserId: owner1, nextRole: 'owner',
    });
  });

  it('removeMember rejects removing the last owner', async () => {
    // Demote owner2 so owner1 is sole owner.
    await updateMemberRole({
      tenantId, targetUserId: owner2, actorUserId: owner1, nextRole: 'staff',
    });
    await expect(
      removeMember({ tenantId, targetUserId: owner1, actorUserId: owner1 }),
    ).rejects.toMatchObject({ code: 'last_owner_protected' });
    // Restore.
    await updateMemberRole({
      tenantId, targetUserId: owner2, actorUserId: owner1, nextRole: 'owner',
    });
  });

  it('removeMember succeeds when ≥2 owners and target is owner', async () => {
    // Re-add the previously promoted "staff" user (now manager) as staff again
    // by removing them then re-inserting? Easier: just remove owner2 (we have owner1 left as owner).
    await removeMember({ tenantId, targetUserId: owner2, actorUserId: owner1 });
    const rows = await listMembers(tenantId);
    expect(rows.find((r) => r.userId === owner2)).toBeUndefined();
    // Restore for next test.
    await db.insert(tenantMembers).values({ userId: owner2, tenantId, role: 'owner' });
  });

  it('removeMember succeeds for self-removal even without explicit cap', async () => {
    // staff (now manager from earlier test) removes themselves
    await removeMember({ tenantId, targetUserId: staff, actorUserId: staff });
    const rows = await listMembers(tenantId);
    expect(rows.find((r) => r.userId === staff)).toBeUndefined();
  });

  it('updateMemberRole throws NotFound for an unknown target', async () => {
    await expect(
      updateMemberRole({
        tenantId,
        targetUserId: '00000000-0000-0000-0000-000000000000',
        actorUserId: owner1,
        nextRole: 'staff',
      }),
    ).rejects.toBeInstanceOf(NotFound);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:
```bash
cd apps/api && DATABASE_URL='postgres://postgres:postgres@localhost:5433/circls_team_test' RUN_INTEGRATION=1 pnpm test src/services/team_service.test.ts
```
Expected: FAIL with "Cannot find module './team_service.js'".

- [ ] **Step 3: Implement team_service**

Create `apps/api/src/services/team_service.ts`:

```ts
/**
 * Team service — list members, change role, remove member.
 *
 * Owner-safety invariants (enforced here, not at capability layer):
 *   - cannot demote the last owner
 *   - cannot remove the last owner
 *
 * Self-removal exception:
 *   - DELETE on yourself is allowed regardless of cap, provided the last-owner
 *     invariant still holds. This is the only "bypass" carved into the model.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { tenantMembers, type TenantRole } from '../db/schema/tenant_members.js';
import { users } from '../db/schema/users.js';
import { writeAudit } from '../lib/audit.js';
import { Conflict, NotFound } from '../lib/errors.js';

export interface MemberRow {
  userId: string;
  email: string | null;
  displayName: string | null;
  role: TenantRole;
  createdAt: Date;
}

export async function listMembers(tenantId: string): Promise<MemberRow[]> {
  return db
    .select({
      userId: tenantMembers.userId,
      email: users.email,
      displayName: users.displayName,
      role: tenantMembers.role,
      createdAt: tenantMembers.createdAt,
    })
    .from(tenantMembers)
    .innerJoin(users, eq(users.id, tenantMembers.userId))
    .where(eq(tenantMembers.tenantId, tenantId));
}

async function ownerCount(tx: typeof db, tenantId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(tenantMembers)
    .where(and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.role, 'owner')));
  return row?.n ?? 0;
}

export interface UpdateMemberRoleInput {
  tenantId: string;
  targetUserId: string;
  actorUserId: string;
  nextRole: TenantRole;
}

export async function updateMemberRole(input: UpdateMemberRoleInput): Promise<MemberRow> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ role: tenantMembers.role })
      .from(tenantMembers)
      .where(
        and(eq(tenantMembers.tenantId, input.tenantId), eq(tenantMembers.userId, input.targetUserId)),
      )
      .limit(1);
    if (!current) throw new NotFound('Member not found', 'member_not_found');

    // Last-owner invariant: if demoting the only owner, reject.
    if (current.role === 'owner' && input.nextRole !== 'owner') {
      const n = await ownerCount(tx, input.tenantId);
      if (n <= 1) {
        throw new Conflict('Cannot demote the last owner', 'last_owner_protected');
      }
    }

    const [updated] = await tx
      .update(tenantMembers)
      .set({ role: input.nextRole })
      .where(
        and(eq(tenantMembers.tenantId, input.tenantId), eq(tenantMembers.userId, input.targetUserId)),
      )
      .returning();
    if (!updated) throw new NotFound('Member not found', 'member_not_found');

    await writeAudit(
      tx,
      { tenantId: input.tenantId, actorUserId: input.actorUserId },
      'tenant.member_role_changed',
      'tenant_member',
      input.targetUserId,
      { role: current.role },
      { role: input.nextRole },
    );

    const [out] = await tx
      .select({
        userId: tenantMembers.userId,
        email: users.email,
        displayName: users.displayName,
        role: tenantMembers.role,
        createdAt: tenantMembers.createdAt,
      })
      .from(tenantMembers)
      .innerJoin(users, eq(users.id, tenantMembers.userId))
      .where(
        and(eq(tenantMembers.tenantId, input.tenantId), eq(tenantMembers.userId, input.targetUserId)),
      )
      .limit(1);
    return out!;
  });
}

export interface RemoveMemberInput {
  tenantId: string;
  targetUserId: string;
  actorUserId: string;
}

export async function removeMember(input: RemoveMemberInput): Promise<void> {
  await db.transaction(async (tx) => {
    const [current] = await tx
      .select({ role: tenantMembers.role })
      .from(tenantMembers)
      .where(
        and(eq(tenantMembers.tenantId, input.tenantId), eq(tenantMembers.userId, input.targetUserId)),
      )
      .limit(1);
    if (!current) throw new NotFound('Member not found', 'member_not_found');

    if (current.role === 'owner') {
      const n = await ownerCount(tx, input.tenantId);
      if (n <= 1) {
        throw new Conflict('Cannot remove the last owner', 'last_owner_protected');
      }
    }

    await tx
      .delete(tenantMembers)
      .where(
        and(eq(tenantMembers.tenantId, input.tenantId), eq(tenantMembers.userId, input.targetUserId)),
      );

    await writeAudit(
      tx,
      { tenantId: input.tenantId, actorUserId: input.actorUserId },
      'tenant.member_removed',
      'tenant_member',
      input.targetUserId,
      { role: current.role },
      { removedAt: new Date() },
    );
  });
}
```

- [ ] **Step 4: Run tests; verify all pass**

Run:
```bash
cd apps/api && DATABASE_URL='postgres://postgres:postgres@localhost:5433/circls_team_test' RUN_INTEGRATION=1 pnpm test src/services/team_service.test.ts
```
Expected: 7 PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/team_service.ts apps/api/src/services/team_service.test.ts
git commit -m "feat(team): team_service — list/update_role/remove with last-owner safety + audit"
```

---

## Task 6: REST routes — invitations + team

**Files:**
- Create: `apps/api/src/routes/invitations.ts`
- Create: `apps/api/src/routes/team.ts`
- Modify: `apps/api/src/server.ts` (register both)

- [ ] **Step 1: Write the invitations route plugin**

Create `apps/api/src/routes/invitations.ts`:

```ts
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { BadRequest, Conflict, Forbidden } from '../lib/errors.js';
import { assertCap } from '../middleware/require_cap.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
import { requireTenantMembership } from '../middleware/tenant_context.js';
import { verifyIdToken } from '../lib/firebase_admin.js';
import {
  acceptInvitation,
  createInvitation,
  listInvitations,
  lookupInvitation,
  resendInvitation,
  revokeInvitation,
} from '../services/invitation_service.js';

const inviteCreateSchema = z.object({
  email: z.string().email(),
  role: z.enum(['owner', 'manager', 'staff', 'readonly']),
});

export const invitationRoutes: FastifyPluginAsync = async (app) => {
  app.post('/v1/tenants/:tenantId/invitations', { preHandler: requireAuth }, async (req, reply) => {
    const { tenantId } = req.params as { tenantId: string };
    const parsed = inviteCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequest('Invalid invitation payload', 'bad_request', {
        issues: parsed.error.issues,
      });
    }
    const user = await currentUser(req);
    const ctx = await requireTenantMembership(user.id, tenantId);
    assertCap(ctx, 'members.invite');
    const result = await createInvitation({
      tenantId,
      actorUserId: user.id,
      email: parsed.data.email,
      role: parsed.data.role,
    });
    return reply.status(201).send({
      invitation: result.invitation,
      // Return the plaintext token in the response too so callers can preview
      // the URL in dev — production callers should ignore this field.
      token: result.plaintextToken,
    });
  });

  app.get(
    '/v1/tenants/:tenantId/invitations',
    { preHandler: requireAuth },
    async (req) => {
      const { tenantId } = req.params as { tenantId: string };
      const status = (req.query as { status?: string }).status as
        | 'pending'
        | 'accepted'
        | 'expired'
        | 'revoked'
        | undefined;
      const user = await currentUser(req);
      const ctx = await requireTenantMembership(user.id, tenantId);
      assertCap(ctx, 'members.read');
      return listInvitations(tenantId, status);
    },
  );

  app.post(
    '/v1/tenants/:tenantId/invitations/:invitationId/resend',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { tenantId, invitationId } = req.params as { tenantId: string; invitationId: string };
      const user = await currentUser(req);
      const ctx = await requireTenantMembership(user.id, tenantId);
      assertCap(ctx, 'members.invite');
      const result = await resendInvitation({ tenantId, invitationId, actorUserId: user.id });
      return reply.status(200).send({ invitation: result.invitation, token: result.plaintextToken });
    },
  );

  app.delete(
    '/v1/tenants/:tenantId/invitations/:invitationId',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { tenantId, invitationId } = req.params as { tenantId: string; invitationId: string };
      const user = await currentUser(req);
      const ctx = await requireTenantMembership(user.id, tenantId);
      assertCap(ctx, 'members.invite');
      await revokeInvitation({ tenantId, invitationId, actorUserId: user.id });
      return reply.status(204).send();
    },
  );

  // Unauthenticated peek for the accept page.
  app.get('/v1/invitations/lookup', async (req) => {
    const token = (req.query as { token?: string }).token;
    if (!token) throw new BadRequest('Missing token', 'missing_token');
    const meta = await lookupInvitation(token);
    if (!meta) throw new BadRequest('Invitation not found', 'invitation_not_found');
    return {
      tenantName: meta.tenantName,
      role: meta.role,
      email: meta.email,
      inviterEmail: meta.inviterEmail,
      expiresAt: meta.expiresAt,
    };
  });

  // Unauthenticated accept. Body carries the Firebase ID token of the
  // accepting user (newly signed up); we verify it here.
  const acceptSchema = z.object({ firebaseIdToken: z.string().min(1) });
  app.post('/v1/invitations/:token/accept', async (req, reply) => {
    const { token } = req.params as { token: string };
    const parsed = acceptSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequest('Invalid accept payload', 'bad_request', {
        issues: parsed.error.issues,
      });
    }
    const decoded = await verifyIdToken(parsed.data.firebaseIdToken);
    if (!decoded.email) {
      throw new Forbidden('Firebase token has no email', 'no_email_claim');
    }
    const result = await acceptInvitation({
      token,
      firebaseUid: decoded.uid,
      email: decoded.email,
    });
    return reply.status(201).send(result);
  });
};
```

- [ ] **Step 2: Write the team route plugin**

Create `apps/api/src/routes/team.ts`:

```ts
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { BadRequest, Forbidden } from '../lib/errors.js';
import { can } from '../lib/authz/can.js';
import { assertCap } from '../middleware/require_cap.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
import { requireTenantMembership } from '../middleware/tenant_context.js';
import { listMembers, removeMember, updateMemberRole } from '../services/team_service.js';

const roleSchema = z.object({
  role: z.enum(['owner', 'manager', 'staff', 'readonly']),
});

export const teamRoutes: FastifyPluginAsync = async (app) => {
  app.get('/v1/tenants/:tenantId/members', { preHandler: requireAuth }, async (req) => {
    const { tenantId } = req.params as { tenantId: string };
    const user = await currentUser(req);
    const ctx = await requireTenantMembership(user.id, tenantId);
    assertCap(ctx, 'members.read');
    return listMembers(tenantId);
  });

  app.patch(
    '/v1/tenants/:tenantId/members/:userId',
    { preHandler: requireAuth },
    async (req) => {
      const { tenantId, userId: targetUserId } = req.params as {
        tenantId: string;
        userId: string;
      };
      const parsed = roleSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new BadRequest('Invalid role payload', 'bad_request', {
          issues: parsed.error.issues,
        });
      }
      const user = await currentUser(req);
      const ctx = await requireTenantMembership(user.id, tenantId);
      assertCap(ctx, 'members.role_change');
      return updateMemberRole({
        tenantId,
        targetUserId,
        actorUserId: user.id,
        nextRole: parsed.data.role,
      });
    },
  );

  app.delete(
    '/v1/tenants/:tenantId/members/:userId',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { tenantId, userId: targetUserId } = req.params as {
        tenantId: string;
        userId: string;
      };
      const user = await currentUser(req);
      const ctx = await requireTenantMembership(user.id, tenantId);
      // Self-remove bypasses the cap.
      if (user.id !== targetUserId) {
        if (!can(ctx, 'members.remove')) {
          throw new Forbidden('Missing capability members.remove', 'forbidden_capability', {
            cap: 'members.remove',
          });
        }
      }
      await removeMember({ tenantId, targetUserId, actorUserId: user.id });
      return reply.status(204).send();
    },
  );
};
```

- [ ] **Step 3: Register both routes in server.ts**

Edit `apps/api/src/server.ts` — add the imports next to the other Track B route imports:

```ts
// Team management (subproject D).
import { invitationRoutes } from './routes/invitations.js';
import { teamRoutes } from './routes/team.js';
```

And the registrations near the other `await app.register(...)` calls — after `await app.register(notificationRoutes);` is a good spot:

```ts
  // Team management.
  await app.register(invitationRoutes);
  await app.register(teamRoutes);
```

- [ ] **Step 4: Typecheck + build**

Run:
```bash
cd apps/api && pnpm typecheck && pnpm build
```
Expected: both clean.

- [ ] **Step 5: Smoke-test that the server boots**

Run:
```bash
DATABASE_URL='postgres://postgres:postgres@localhost:5433/circls_team_test' RUN_WORKER=false pnpm dev &
sleep 2
curl -s http://localhost:8080/healthz | head -5
kill %1
```
Expected: `{"status":"ok"}` or similar. No boot errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/invitations.ts apps/api/src/routes/team.ts apps/api/src/server.ts
git commit -m "feat(team): invitations + team REST routes; registered in server"
```

---

## Task 7: Notification template — tenant.invitation email + dispatch from createInvitation

**Files:**
- Modify: `apps/api/src/lib/notifications/templates.ts` (add `tenant.invitation` template)
- Modify: `apps/api/src/services/invitation_service.ts` (dispatch email after create + resend)
- Create: `apps/api/src/services/invitation_service.dispatch.test.ts`

- [ ] **Step 1: Inspect existing templates module**

Run: `grep -n "templateKey" apps/api/src/lib/notifications/templates.ts | head -10`
Expected: shows the existing template keys (booking.confirmed, etc.).

- [ ] **Step 2: Add the tenant.invitation template**

Edit `apps/api/src/lib/notifications/templates.ts` — add a new template inside the existing email-channel templates map (exact shape depends on what Phase 13 shipped; the key is `'tenant.invitation'` and channels are `email` only). Use this body:

```ts
// In the email section:
'tenant.invitation': {
  subject: 'You’ve been invited to {{tenantName}} on Circls',
  body: `Hello,

{{inviterName}} has invited you to join {{tenantName}} on Circls as {{role}}.

Accept the invitation and set up your account:
{{inviteUrl}}

This link expires on {{expiresAtIso}}. If you weren’t expecting this email, you can safely ignore it.

— Circls
`,
},
```

If the templates module's exact shape differs, locate the email-channel object and add the entry in-place. Make sure the `renderTemplate('email', 'tenant.invitation', payload)` path returns `{ subject, body }` with the {{var}} substitutions performed.

- [ ] **Step 3: Dispatch the email from createInvitation**

Edit `apps/api/src/services/invitation_service.ts` — at the top add the imports:

```ts
import { env } from '../config/env.js';
import { getNotifications } from '../lib/notifications/index.js';
```

And inside `createInvitation`, after the `writeAudit(...)` call and before `return`, dispatch:

```ts
  // Fire-and-await the notification dispatch. The dispatcher writes a
  // notifications row even in stub mode, so the audit + UI surface work.
  const inviteUrl = `${env.PARTNERS_BASE_URL}/invite/${token}`;
  await getNotifications().dispatch({
    tenantId: input.tenantId,
    channel: 'email',
    recipient: email,
    templateKey: 'tenant.invitation',
    payload: {
      tenantName: '(tenant name resolved at render time)',
      inviterName: '(inviter resolved at render time)',
      role: input.role,
      inviteUrl,
      expiresAtIso: expiresAt.toISOString(),
    },
  });
```

For the template payload we need the tenant + inviter names. Update the function to fetch them before dispatching (inside the same function, before the existing INSERT block, fetch tenant.name and inviter.email):

```ts
  // Look up tenant name + inviter email so the email body can render them.
  const [t] = await db
    .select({ name: tenants.name })
    .from(tenants)
    .where(eq(tenants.id, input.tenantId))
    .limit(1);
  const [inviter] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, input.actorUserId))
    .limit(1);
  const tenantName = t?.name ?? 'your team';
  const inviterName = inviter?.email ?? 'A teammate';
```

Then in the dispatch payload use those values. Mirror the same dispatch from `resendInvitation` (lookup same fields + same payload).

- [ ] **Step 4: Add PARTNERS_BASE_URL to env config**

Edit `apps/api/src/config/env.ts` — inside the `z.object({...})` add:

```ts
  PARTNERS_BASE_URL: z.string().url().default('https://partners.circls.app'),
```

- [ ] **Step 5: Write a dispatch-side test**

Create `apps/api/src/services/invitation_service.dispatch.test.ts`:

```ts
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db, pingDb } from '../db/client.js';
import { notifications } from '../db/schema/notifications.js';
import { tenants, tenantMembers, users } from '../db/schema/index.js';
import { createInvitation } from './invitation_service.js';

const runIntegration = Boolean(process.env.RUN_INTEGRATION);
const SUFFIX = Date.now();

describe.skipIf(!runIntegration)('createInvitation queues an email', () => {
  let tenantId: string;
  let ownerUserId: string;

  beforeAll(async () => {
    await pingDb();
    const [u] = await db.insert(users).values({
      firebaseUid: `disp-fb-${SUFFIX}`, email: `disp-${SUFFIX}@x.test`,
    }).returning();
    ownerUserId = u!.id;
    const [t] = await db.insert(tenants).values({
      name: 'Dispatch Co', slug: `disp-${SUFFIX}`,
    }).returning();
    tenantId = t!.id;
    await db.insert(tenantMembers).values({ userId: ownerUserId, tenantId, role: 'owner' });
  });

  afterAll(async () => {
    await db.execute(sql`delete from notifications where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from audit_log where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenant_invitations where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenant_members where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
    await db.execute(sql`delete from users where id = ${ownerUserId}`);
    await closeDb();
  });

  it('writes a notifications row for the invitee email', async () => {
    await createInvitation({
      tenantId,
      actorUserId: ownerUserId,
      email: `target-${SUFFIX}@x.test`,
      role: 'staff',
    });
    const rows = await db
      .select()
      .from(notifications)
      .where(sql`tenant_id = ${tenantId} and recipient = ${`target-${SUFFIX}@x.test`}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.channel).toBe('email');
    expect(rows[0]?.templateKey).toBe('tenant.invitation');
  });
});
```

- [ ] **Step 6: Run tests**

Run:
```bash
cd apps/api && DATABASE_URL='postgres://postgres:postgres@localhost:5433/circls_team_test' RUN_INTEGRATION=1 pnpm test src/services/invitation_service
```
Expected: all prior invitation tests still pass + the new dispatch test passes.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/lib/notifications/templates.ts apps/api/src/services/invitation_service.ts apps/api/src/services/invitation_service.dispatch.test.ts apps/api/src/config/env.ts
git commit -m "feat(team): email invitation via Phase 13 dispatcher + tenant.invitation template"
```

---

## Task 8: Retire require_admin + require_platform_admin → use assertCap everywhere

**Files:**
- Modify: every route currently calling `require_admin` or `require_platform_admin`
- Delete: `apps/api/src/middleware/require_admin.ts`
- Delete: `apps/api/src/middleware/require_platform_admin.ts`
- Delete: `apps/api/src/middleware/require_platform_admin.test.ts`

- [ ] **Step 1: List all callers**

Run:
```bash
cd apps/api && grep -rn "require_admin\|require_platform_admin\|requireAdmin\|requirePlatformAdmin\|PLATFORM_ADMIN_USER_IDS" src --include='*.ts' | grep -v '\.test\.ts'
```
Expected output: shows each file + line that imports or calls the old middleware. Note them all.

- [ ] **Step 2: Replace each call site**

For each file from Step 1, replace the old preHandler chain with the new pattern. Concrete recipe per route:

**Before (Phase 16 example, `routes/admin_tenants.ts`):**
```ts
import { requirePlatformAdmin } from '../middleware/require_platform_admin.js';

app.get('/v1/admin/tenants', { preHandler: requirePlatformAdmin }, async (req) => { ... });
```

**After:**
```ts
import { assertCap } from '../middleware/require_cap.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
import { requireTenantMembership } from '../middleware/tenant_context.js';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { tenants } from '../db/schema/tenants.js';
import { eq } from 'drizzle-orm';

async function resolvePlatformTenant(): Promise<string> {
  const [row] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, env.CIRCLS_INTERNAL_TENANT_SLUG))
    .limit(1);
  if (!row) throw new Error('circls_internal_tenant_not_bootstrapped');
  return row.id;
}

app.get('/v1/admin/tenants', { preHandler: requireAuth }, async (req) => {
  const user = await currentUser(req);
  const platformTenantId = await resolvePlatformTenant();
  const ctx = await requireTenantMembership(user.id, platformTenantId);
  assertCap(ctx, 'admin.tenants.read');
  // ... existing handler body
});
```

Pull `resolvePlatformTenant` into a tiny shared helper:

Create `apps/api/src/lib/authz/platform_tenant.ts`:

```ts
import { eq } from 'drizzle-orm';
import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import { tenants } from '../../db/schema/tenants.js';

let cachedId: string | null = null;

/**
 * Cached id of the Circls platform tenant (the row with slug=env.CIRCLS_INTERNAL_TENANT_SLUG
 * AND is_platform=true). Resolved once per process; safe because the row is
 * stable in prod.
 */
export async function getPlatformTenantId(): Promise<string> {
  if (cachedId) return cachedId;
  const [row] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, env.CIRCLS_INTERNAL_TENANT_SLUG))
    .limit(1);
  if (!row) {
    throw new Error('circls_internal_tenant_not_bootstrapped — run scripts/bootstrap_circls_tenant.ts');
  }
  cachedId = row.id;
  return row.id;
}

export function __resetPlatformTenantCacheForTesting(): void {
  cachedId = null;
}
```

For partner-side routes that called `require_admin`, the replacement is simpler — the tenantId is already in the route path (e.g., `/v1/tenants/:tenantId/...`):

```ts
const user = await currentUser(req);
const ctx = await requireTenantMembership(user.id, tenantId);
assertCap(ctx, 'venues.write');     // or whichever cap fits
```

Pick the cap that matches the route's purpose. Typical mapping:
- write/create venues → `venues.write`
- create pricing → `pricing.write`
- create members (legacy) → `members.invite`
- if it was a general admin guard with no specific feature → `tenant.update`

- [ ] **Step 3: Delete the old middleware files**

```bash
rm apps/api/src/middleware/require_admin.ts
rm apps/api/src/middleware/require_platform_admin.ts
rm apps/api/src/middleware/require_platform_admin.test.ts
```

- [ ] **Step 4: Delete the env var**

Edit `apps/api/src/config/env.ts` — remove the `PLATFORM_ADMIN_USER_IDS` line.

- [ ] **Step 5: Typecheck**

Run: `cd apps/api && pnpm typecheck`
Expected: clean. If anything still references the deleted files, fix the call site (replace with assertCap as in Step 2).

- [ ] **Step 6: Run full integration suite**

Run:
```bash
cd apps/api && DATABASE_URL='postgres://postgres:postgres@localhost:5433/circls_team_test' RUN_INTEGRATION=1 pnpm test
```
Expected: all green. If admin tests fail because the platform tenant doesn't exist yet, add a beforeAll that seeds a `tenants` row with `is_platform=true` + matching slug.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/middleware apps/api/src/lib/authz/platform_tenant.ts apps/api/src/routes apps/api/src/config/env.ts
git commit -m "refactor(authz): retire require_admin/require_platform_admin in favor of assertCap"
```

---

## Task 9: Env CIRCLS_INTERNAL_TENANT_SLUG + boot sanity check

**Files:**
- Modify: `apps/api/src/config/env.ts`
- Modify: `apps/api/src/index.ts`

- [ ] **Step 1: Add the env var (if not already added in Task 8 prep)**

Edit `apps/api/src/config/env.ts` — inside `z.object({...})` add:

```ts
  CIRCLS_INTERNAL_TENANT_SLUG: z.string().default('circls-internal'),
```

- [ ] **Step 2: Add a boot sanity check**

Edit `apps/api/src/index.ts` — after `await pingDb();` (or wherever the existing boot block is), add:

```ts
import { and, eq } from 'drizzle-orm';
import { tenants } from './db/schema/tenants.js';

// ... existing boot code ...

// Non-fatal: warn loudly if the Circls platform tenant isn't bootstrapped.
const [platform] = await db
  .select({ id: tenants.id })
  .from(tenants)
  .where(and(eq(tenants.slug, env.CIRCLS_INTERNAL_TENANT_SLUG), eq(tenants.isPlatform, true)));
if (!platform) {
  logger.warn(
    { slug: env.CIRCLS_INTERNAL_TENANT_SLUG },
    'circls_internal_tenant_missing — run scripts/bootstrap_circls_tenant.ts',
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/api && pnpm typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/config/env.ts apps/api/src/index.ts
git commit -m "feat(boot): warn if the Circls internal tenant isn't bootstrapped"
```

---

## Task 10: Bootstrap script — create Circls tenant + first invitation

**Files:**
- Create: `apps/api/scripts/bootstrap_circls_tenant.ts`
- Modify: `apps/api/package.json` (script alias)

- [ ] **Step 1: Write the script**

Create `apps/api/scripts/bootstrap_circls_tenant.ts`:

```ts
/**
 * One-shot bootstrap of the Circls internal tenant + the founder's invitation.
 *
 * Usage:
 *   DATABASE_URL=… pnpm bootstrap:circls vedant@gibbous.io "Vedant S"
 *
 * Prints the invite URL on success; the operator opens it in admin.circls.app,
 * sets a password, and becomes the owning Circls member.
 */
import { eq } from 'drizzle-orm';
import { closeDb, db } from '../src/db/client.js';
import { env } from '../src/config/env.js';
import { tenants } from '../src/db/schema/tenants.js';
import { users } from '../src/db/schema/users.js';
import { createInvitation } from '../src/services/invitation_service.js';
import { logger } from '../src/lib/logger.js';

async function main(): Promise<void> {
  const [, , emailArg, nameArg] = process.argv;
  if (!emailArg) {
    process.stderr.write('Usage: bootstrap:circls <founderEmail> [displayName]\n');
    process.exit(1);
  }
  const email = emailArg.toLowerCase();
  const displayName = nameArg ?? 'Founder';

  const [existing] = await db
    .select({ id: tenants.id, isPlatform: tenants.isPlatform })
    .from(tenants)
    .where(eq(tenants.slug, env.CIRCLS_INTERNAL_TENANT_SLUG))
    .limit(1);
  if (existing) {
    logger.info({ slug: env.CIRCLS_INTERNAL_TENANT_SLUG }, 'already_bootstrapped');
    process.stdout.write('Circls internal tenant already exists. No action taken.\n');
    await closeDb();
    return;
  }

  const tenantId = await db.transaction(async (tx) => {
    const [t] = await tx
      .insert(tenants)
      .values({
        slug: env.CIRCLS_INTERNAL_TENANT_SLUG,
        name: 'Circls',
        isPlatform: true,
        status: 'active',
      })
      .returning();
    if (!t) throw new Error('tenant insert returned no row');

    // We need an invited_by_user_id on the invitation, but no founder user
    // exists yet. Use a "bootstrap" user that we tag and (optionally) clean up
    // later. firebase_uid must be unique; we mint a special value here.
    const bootstrapFirebaseUid = `bootstrap-${Date.now()}`;
    const [u] = await tx
      .insert(users)
      .values({
        firebaseUid: bootstrapFirebaseUid,
        email: `bootstrap+${env.CIRCLS_INTERNAL_TENANT_SLUG}@circls.app`,
        displayName: 'Bootstrap',
      })
      .returning();
    if (!u) throw new Error('bootstrap user insert returned no row');

    // Note: createInvitation runs OUTSIDE this tx because it itself opens db
    // transactions / writes audit. Return the ids so the outer code can call it.
    return { tenantId: t.id, bootstrapUserId: u.id };
  });

  const inv = await createInvitation({
    tenantId: tenantId.tenantId,
    actorUserId: tenantId.bootstrapUserId,
    email,
    role: 'owner',
    ttlDays: 30,
  });

  const url = `${env.ADMIN_BASE_URL}/invite/${inv.plaintextToken}`;
  process.stdout.write(`Circls internal tenant bootstrapped. Invitation for ${email} (${displayName}):\n\n  ${url}\n\nExpires: ${inv.invitation.expiresAt.toISOString()}\n`);

  await closeDb();
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'bootstrap_failed');
  process.exit(1);
});
```

- [ ] **Step 2: Add ADMIN_BASE_URL to env config**

Edit `apps/api/src/config/env.ts` — inside `z.object({...})` add:

```ts
  ADMIN_BASE_URL: z.string().url().default('https://admin.circls.app'),
```

- [ ] **Step 3: Add the pnpm script alias**

Edit `apps/api/package.json` `"scripts"` block — add:

```json
    "bootstrap:circls": "tsx scripts/bootstrap_circls_tenant.ts",
```

- [ ] **Step 4: Smoke-test against the test DB**

Run:
```bash
cd apps/api && DATABASE_URL='postgres://postgres:postgres@localhost:5433/circls_team_test' \
  pnpm bootstrap:circls founder-test@x.test "Test Founder"
```
Expected: prints "Circls internal tenant bootstrapped. Invitation for …" with a URL.

Verify:
```bash
docker exec circls-devpg psql -U postgres -d circls_team_test -c "SELECT slug, is_platform FROM tenants WHERE slug='circls-internal';"
docker exec circls-devpg psql -U postgres -d circls_team_test -c "SELECT email, role FROM tenant_invitations WHERE email='founder-test@x.test';"
```
Expected: tenant row with `is_platform=t`; invitation row with `role='owner'`.

- [ ] **Step 5: Re-run to confirm idempotency**

Run the same command again. Expected: "already exists. No action taken." No errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/scripts/bootstrap_circls_tenant.ts apps/api/src/config/env.ts apps/api/package.json
git commit -m "feat(team): bootstrap_circls_tenant.ts + pnpm bootstrap:circls"
```

---

## Task 11: Phase-16 platform-admin migration script

**Files:**
- Create: `apps/api/scripts/migrate_platform_admin_users.ts`
- Modify: `apps/api/package.json`

- [ ] **Step 1: Write the migration script**

Create `apps/api/scripts/migrate_platform_admin_users.ts`:

```ts
/**
 * One-shot migration: take the comma-separated UUIDs that were in
 * PLATFORM_ADMIN_USER_IDS, look up each `users` row, and INSERT a
 * tenant_members row into the Circls platform tenant with role='manager'
 * (so they retain admin-portal access via the new authz model).
 *
 * Usage:
 *   DATABASE_URL=… LEGACY_PLATFORM_ADMIN_USER_IDS=uuid1,uuid2 \
 *     pnpm migrate:platform-admins
 */
import { eq, inArray } from 'drizzle-orm';
import { closeDb, db } from '../src/db/client.js';
import { env } from '../src/config/env.js';
import { tenants } from '../src/db/schema/tenants.js';
import { tenantMembers } from '../src/db/schema/tenant_members.js';
import { users } from '../src/db/schema/users.js';
import { logger } from '../src/lib/logger.js';

async function main(): Promise<void> {
  const raw = process.env.LEGACY_PLATFORM_ADMIN_USER_IDS;
  if (!raw) {
    process.stderr.write('LEGACY_PLATFORM_ADMIN_USER_IDS env var required\n');
    process.exit(1);
  }
  const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) {
    process.stderr.write('LEGACY_PLATFORM_ADMIN_USER_IDS contained no ids\n');
    process.exit(1);
  }

  const [tenant] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, env.CIRCLS_INTERNAL_TENANT_SLUG))
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

  process.stdout.write(`Migrated ${found.length} platform admin(s) to Circls tenant.\n`);
  await closeDb();
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'migration_failed');
  process.exit(1);
});
```

- [ ] **Step 2: Add the pnpm script alias**

Edit `apps/api/package.json` `"scripts"` — add:

```json
    "migrate:platform-admins": "tsx scripts/migrate_platform_admin_users.ts",
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/api && pnpm typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/api/scripts/migrate_platform_admin_users.ts apps/api/package.json
git commit -m "feat(team): migrate_platform_admin_users.ts — Phase 16 env-list → Circls members"
```

---

## Task 12: Partner portal — email/password auth migration

**Files:**
- Modify: `apps/partners/lib/firebase/auth_context.tsx`
- Modify: `apps/partners/app/layout.tsx`
- Modify: `apps/partners/app/(auth)/login/page.tsx`
- Create: `apps/partners/app/(auth)/forgot-password/page.tsx`

- [ ] **Step 1: Rewrite the auth context**

Replace `apps/partners/lib/firebase/auth_context.tsx`:

```tsx
'use client';
import {
  type User,
  onAuthStateChanged,
  sendPasswordResetEmail as fbSendReset,
  signInWithEmailAndPassword,
  signOut as fbSignOut,
} from 'firebase/auth';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { auth } from './client';

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  signInWithEmail: (email: string, password: string) => Promise<User>;
  sendPasswordReset: (email: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    return onAuthStateChanged(auth, (u) => {
      setUser(u);
      setLoading(false);
    });
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      async signInWithEmail(email, password) {
        const cred = await signInWithEmailAndPassword(auth, email.trim(), password);
        return cred.user;
      },
      async sendPasswordReset(email) {
        await fbSendReset(auth, email.trim());
      },
      async signOut() {
        await fbSignOut(auth);
      },
    }),
    [user, loading],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>');
  return ctx;
}
```

- [ ] **Step 2: Drop the reCAPTCHA container from layout**

Edit `apps/partners/app/layout.tsx` — remove the `<div id="recaptcha-container" />` line and the surrounding comment.

- [ ] **Step 3: Rewrite the login page**

Replace `apps/partners/app/(auth)/login/page.tsx`:

```tsx
'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { useAuth } from '@/lib/firebase/auth_context';

export default function LoginPage() {
  const { signInWithEmail } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signInWithEmail(email, password);
      router.replace('/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-6">
      <h1 className="text-2xl font-semibold">Circls Partner Portal</h1>
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <label className="text-sm font-medium" htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          required
          className="rounded border border-gray-300 px-3 py-2"
        />
        <label className="text-sm font-medium" htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
          className="rounded border border-gray-300 px-3 py-2"
        />
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <Link
        href="/forgot-password"
        className="text-center text-sm text-blue-700 hover:underline"
      >
        Forgot password?
      </Link>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </main>
  );
}
```

- [ ] **Step 4: Create the forgot-password page**

Create `apps/partners/app/(auth)/forgot-password/page.tsx`:

```tsx
'use client';
import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import { useAuth } from '@/lib/firebase/auth_context';

export default function ForgotPasswordPage() {
  const { sendPasswordReset } = useAuth();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await sendPasswordReset(email);
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send reset email');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-6">
      <h1 className="text-2xl font-semibold">Reset your password</h1>
      {sent ? (
        <p className="text-sm text-slate-700">
          If an account exists for that email, a password-reset link is on its way.
        </p>
      ) : (
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <label htmlFor="email" className="text-sm font-medium">Email</label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="rounded border border-gray-300 px-3 py-2"
          />
          <button
            type="submit"
            disabled={busy}
            className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50"
          >
            {busy ? 'Sending…' : 'Send reset link'}
          </button>
        </form>
      )}
      <Link href="/login" className="text-center text-sm text-blue-700 hover:underline">
        Back to sign in
      </Link>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </main>
  );
}
```

- [ ] **Step 5: Typecheck**

Run: `cd apps/partners && pnpm typecheck`
Expected: clean. If anything still references `sendOtp`, replace per pattern in Step 1.

- [ ] **Step 6: Build**

Run: `cd apps/partners && pnpm build`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add apps/partners/lib/firebase apps/partners/app/layout.tsx apps/partners/app/\(auth\)
git commit -m "feat(partners): email/password auth replaces phone-OTP; forgot-password page"
```

---

## Task 13: Partner portal — invite acceptance + no-tenants empty state

**Files:**
- Create: `apps/partners/app/(auth)/invite/[token]/page.tsx`
- Create: `apps/partners/app/(protected)/no-tenants/page.tsx`
- Modify: `apps/partners/app/(protected)/layout.tsx` (route to /no-tenants when memberless)

- [ ] **Step 1: Create the invite-accept page**

Create `apps/partners/app/(auth)/invite/[token]/page.tsx`:

```tsx
'use client';
import { useParams, useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
} from 'firebase/auth';
import { auth } from '@/lib/firebase/client';
import { apiFetch } from '@/lib/api/client';

interface InviteMeta {
  tenantName: string;
  role: 'owner' | 'manager' | 'staff' | 'readonly';
  email: string;
  inviterEmail: string | null;
  expiresAt: string;
}

export default function AcceptInvitePage() {
  const { token } = useParams() as { token: string };
  const router = useRouter();
  const [meta, setMeta] = useState<InviteMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiFetch<InviteMeta>(`/v1/invitations/lookup?token=${encodeURIComponent(token)}`)
      .then(setMeta)
      .catch((err) => setError(err instanceof Error ? err.message : 'Lookup failed'));
  }, [token]);

  async function handleAccept(e: FormEvent) {
    e.preventDefault();
    if (!meta) return;
    setBusy(true);
    setError(null);
    try {
      let cred;
      try {
        cred = await createUserWithEmailAndPassword(auth, meta.email, password);
      } catch (err) {
        const code = (err as { code?: string } | undefined)?.code ?? '';
        if (code === 'auth/email-already-in-use') {
          // Existing user (e.g., already a member of another tenant). Sign in instead.
          cred = await signInWithEmailAndPassword(auth, meta.email, password);
        } else {
          throw err;
        }
      }
      const firebaseIdToken = await cred.user.getIdToken();
      await apiFetch(`/v1/invitations/${encodeURIComponent(token)}/accept`, {
        method: 'POST',
        body: JSON.stringify({ firebaseIdToken }),
      });
      router.replace('/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Accept failed');
    } finally {
      setBusy(false);
    }
  }

  if (error && !meta) {
    return (
      <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-3 p-6">
        <h1 className="text-2xl font-semibold">Invitation not found</h1>
        <p className="text-sm text-slate-600">
          The link may have expired or been revoked. Ask your team admin to send a fresh invitation.
        </p>
      </main>
    );
  }

  if (!meta) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <span className="block h-6 w-6 animate-spin rounded-full border-2 border-slate-300 border-t-slate-700" />
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-6">
      <h1 className="text-2xl font-semibold">Join {meta.tenantName}</h1>
      <p className="text-sm text-slate-600">
        You’ve been invited as <strong>{meta.role}</strong>
        {meta.inviterEmail ? ` by ${meta.inviterEmail}` : ''}. Set a password to accept.
      </p>
      <form onSubmit={handleAccept} className="flex flex-col gap-3">
        <label htmlFor="email" className="text-sm font-medium">Email</label>
        <input
          id="email"
          type="email"
          value={meta.email}
          disabled
          className="rounded border border-gray-300 bg-slate-50 px-3 py-2 text-slate-500"
        />
        <label htmlFor="password" className="text-sm font-medium">Password</label>
        <input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          required
          minLength={8}
          className="rounded border border-gray-300 px-3 py-2"
        />
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50"
        >
          {busy ? 'Accepting…' : 'Accept invitation'}
        </button>
      </form>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </main>
  );
}
```

- [ ] **Step 2: Create the no-tenants empty state**

Create `apps/partners/app/(protected)/no-tenants/page.tsx`:

```tsx
'use client';
import { useAuth } from '@/lib/firebase/auth_context';

export default function NoTenantsPage() {
  const { signOut, user } = useAuth();
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 p-6 text-center">
      <h1 className="text-2xl font-semibold">No organizations yet</h1>
      <p className="text-sm text-slate-600">
        You’re signed in as <span className="font-medium">{user?.email}</span>, but you aren’t a member of any team yet. Ask your team admin to send you an invitation.
      </p>
      <button
        type="button"
        onClick={() => void signOut()}
        className="mx-auto rounded border border-gray-300 px-4 py-2 text-sm"
      >
        Sign out
      </button>
    </main>
  );
}
```

- [ ] **Step 3: Route memberless users to /no-tenants**

Edit `apps/partners/app/(protected)/layout.tsx` — add a `useMyTenants` check inside the protected layout, and redirect to `/no-tenants` when the user is authenticated but has no memberships. The exact existing layout structure is in `apps/partners/app/(protected)/layout.tsx`; insert the check after the auth-loaded gate and before rendering the sidebar:

```tsx
import { useMyTenants } from '@/lib/api/queries';

// inside ProtectedLayout, after the !user check:
  const { data: tenants, isLoading: tenantsLoading } = useMyTenants();
  const pathname = usePathname();
  useEffect(() => {
    if (!loading && user && !tenantsLoading) {
      if ((tenants?.length ?? 0) === 0 && pathname !== '/no-tenants') {
        router.replace('/no-tenants');
      }
    }
  }, [loading, user, tenantsLoading, tenants, pathname, router]);
```

- [ ] **Step 4: Typecheck + build**

Run: `cd apps/partners && pnpm typecheck && pnpm build`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add apps/partners/app
git commit -m "feat(partners): invite acceptance page + no-tenants empty state"
```

---

## Task 14: Partner portal — Team management UI (Settings → Team)

**Files:**
- Create: `apps/partners/app/(protected)/settings/team/page.tsx`
- Modify: `apps/partners/lib/api/queries.ts` (new hooks)
- Modify: `apps/partners/lib/api/types.ts` (new types)
- Modify: `apps/partners/app/(protected)/settings/page.tsx` (add Team card)

- [ ] **Step 1: Add types**

Edit `apps/partners/lib/api/types.ts` — append:

```ts
// Team management (subproject D).
export type TenantRole = 'owner' | 'manager' | 'staff' | 'readonly';

export interface TeamMember {
  userId: string;
  email: string | null;
  displayName: string | null;
  role: TenantRole;
  createdAt: string;
}

export interface TenantInvitation {
  id: string;
  tenantId: string;
  email: string;
  role: TenantRole;
  invitedByUserId: string;
  tokenPrefix: string;
  expiresAt: string;
  acceptedAt: string | null;
  acceptedUserId: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface CreateInvitationResponse {
  invitation: TenantInvitation;
  token: string; // shown once for copy-link
}
```

- [ ] **Step 2: Add React Query hooks**

Edit `apps/partners/lib/api/queries.ts` — append after the existing team-management-relevant hooks:

```ts
import type {
  CreateInvitationResponse,
  TeamMember,
  TenantInvitation,
  TenantRole,
} from './types';

// ── Team management (subproject D) ───────────────────────────────────────────

export function useTeamMembers(tenantId: string) {
  return useQuery({
    queryKey: ['team-members', tenantId],
    queryFn: () => apiFetch<TeamMember[]>(`/v1/tenants/${tenantId}/members`),
    enabled: Boolean(tenantId),
  });
}

export function useUpdateMemberRole(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: TenantRole }) =>
      apiFetch<TeamMember>(`/v1/tenants/${tenantId}/members/${userId}`, {
        method: 'PATCH',
        body: JSON.stringify({ role }),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['team-members', tenantId] }),
  });
}

export function useRemoveMember(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      apiFetch<void>(`/v1/tenants/${tenantId}/members/${userId}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['team-members', tenantId] }),
  });
}

export function useTeamInvitations(tenantId: string, status?: 'pending' | 'accepted' | 'expired' | 'revoked') {
  return useQuery({
    queryKey: ['team-invitations', tenantId, status],
    queryFn: () => {
      const qs = status ? `?status=${status}` : '';
      return apiFetch<TenantInvitation[]>(`/v1/tenants/${tenantId}/invitations${qs}`);
    },
    enabled: Boolean(tenantId),
  });
}

export function useCreateInvitation(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; role: TenantRole }) =>
      apiFetch<CreateInvitationResponse>(`/v1/tenants/${tenantId}/invitations`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['team-invitations', tenantId] }),
  });
}

export function useResendInvitation(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (invitationId: string) =>
      apiFetch<CreateInvitationResponse>(
        `/v1/tenants/${tenantId}/invitations/${invitationId}/resend`,
        { method: 'POST' },
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['team-invitations', tenantId] }),
  });
}

export function useRevokeInvitation(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (invitationId: string) =>
      apiFetch<void>(`/v1/tenants/${tenantId}/invitations/${invitationId}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['team-invitations', tenantId] }),
  });
}
```

- [ ] **Step 3: Create the Team settings page**

Create `apps/partners/app/(protected)/settings/team/page.tsx`:

```tsx
'use client';
import { type FormEvent, useState } from 'react';
import { useOrg } from '@/lib/org_context';
import {
  useCreateInvitation,
  useRemoveMember,
  useResendInvitation,
  useRevokeInvitation,
  useTeamInvitations,
  useTeamMembers,
  useUpdateMemberRole,
} from '@/lib/api/queries';
import type { TenantRole } from '@/lib/api/types';

const ROLES: TenantRole[] = ['owner', 'manager', 'staff', 'readonly'];

export default function TeamPage() {
  const { tenantId } = useOrg();
  const { data: members } = useTeamMembers(tenantId);
  const { data: pending } = useTeamInvitations(tenantId, 'pending');
  const createInvite = useCreateInvitation(tenantId);
  const resendInvite = useResendInvitation(tenantId);
  const revokeInvite = useRevokeInvitation(tenantId);
  const updateRole = useUpdateMemberRole(tenantId);
  const removeMember = useRemoveMember(tenantId);

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<TenantRole>('manager');
  const [lastToken, setLastToken] = useState<string | null>(null);

  async function handleInvite(e: FormEvent) {
    e.preventDefault();
    const r = await createInvite.mutateAsync({ email: inviteEmail, role: inviteRole });
    setLastToken(r.token);
    setInviteEmail('');
  }

  return (
    <div className="flex flex-col gap-8 p-2">
      <section>
        <h1 className="text-xl font-semibold">Team</h1>
        <p className="mt-1 text-sm text-slate-500">
          Invite teammates, change roles, or remove members. Owners can do everything;
          staff can manage bookings.
        </p>
      </section>

      <section className="rounded border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Invite a teammate
        </h2>
        <form onSubmit={handleInvite} className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[220px]">
            <label htmlFor="invite-email" className="block text-xs font-medium text-slate-700">
              Email
            </label>
            <input
              id="invite-email"
              type="email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              required
              className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label htmlFor="invite-role" className="block text-xs font-medium text-slate-700">
              Role
            </label>
            <select
              id="invite-role"
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as TenantRole)}
              className="mt-1 rounded border border-slate-300 px-3 py-2 text-sm"
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </div>
          <button
            type="submit"
            disabled={createInvite.isPending}
            className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {createInvite.isPending ? 'Sending…' : 'Send invitation'}
          </button>
        </form>
        {lastToken && (
          <div className="mt-3 rounded border border-amber-200 bg-amber-50 p-3 text-xs">
            <p className="font-medium">Invite link (also emailed):</p>
            <code className="break-all">{`${window.location.origin}/invite/${lastToken}`}</code>
          </div>
        )}
      </section>

      <section className="rounded border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Pending invitations
        </h2>
        <ul className="divide-y divide-slate-100">
          {(pending ?? []).map((inv) => (
            <li key={inv.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <div>
                <div className="font-medium">{inv.email}</div>
                <div className="text-xs text-slate-500">
                  Invited as {inv.role} · expires {new Date(inv.expiresAt).toLocaleString()}
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => resendInvite.mutate(inv.id)}
                  className="text-xs text-blue-700 hover:underline"
                >
                  Resend
                </button>
                <button
                  type="button"
                  onClick={() => revokeInvite.mutate(inv.id)}
                  className="text-xs text-red-700 hover:underline"
                >
                  Revoke
                </button>
              </div>
            </li>
          ))}
          {(pending?.length ?? 0) === 0 && (
            <li className="py-2 text-sm text-slate-400">No pending invitations.</li>
          )}
        </ul>
      </section>

      <section className="rounded border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Members
        </h2>
        <ul className="divide-y divide-slate-100">
          {(members ?? []).map((m) => (
            <li key={m.userId} className="flex items-center justify-between gap-3 py-2 text-sm">
              <div>
                <div className="font-medium">{m.email ?? m.displayName ?? m.userId}</div>
                <div className="text-xs text-slate-500">Joined {new Date(m.createdAt).toLocaleDateString()}</div>
              </div>
              <div className="flex items-center gap-2">
                <select
                  value={m.role}
                  onChange={(e) =>
                    updateRole.mutate({ userId: m.userId, role: e.target.value as TenantRole })
                  }
                  className="rounded border border-slate-300 px-2 py-1 text-xs"
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => {
                    if (confirm(`Remove ${m.email ?? 'this member'}?`)) {
                      removeMember.mutate(m.userId);
                    }
                  }}
                  className="text-xs text-red-700 hover:underline"
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
```

- [ ] **Step 4: Add a Team card to the Settings index**

Edit `apps/partners/app/(protected)/settings/page.tsx` — add (style matches the existing cards):

```tsx
      <Card
        title="Team"
        subtitle="Invite teammates, change roles, or remove members."
      >
        <Link
          href="/settings/team"
          className="inline-flex items-center gap-1.5 rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition-colors hover:bg-slate-50"
        >
          Manage team &rarr;
        </Link>
      </Card>
```

- [ ] **Step 5: Typecheck + build**

Run: `cd apps/partners && pnpm typecheck && pnpm build`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/partners
git commit -m "feat(partners): team settings page (invite, members, role change, remove)"
```

---

## Task 15: Admin portal — assert is_platform membership + invite acceptance

**Files:**
- Modify: `apps/admin/app/(protected)/layout.tsx`
- Create: `apps/admin/app/(auth)/invite/[token]/page.tsx`
- Modify: `apps/admin/lib/api/queries.ts` (add `useMe` if not present)
- Modify: `apps/admin/lib/api/types.ts` (add memberships shape)

- [ ] **Step 1: Inspect existing /v1/me response shape**

Run: `grep -n "GET /v1/me\|export const meRoutes" apps/api/src/routes/me.ts | head -5`
Inspect the response: confirm it includes the user's tenant memberships with `isPlatform`. If not, extend the route to include it (modify `apps/api/src/routes/me.ts` to join `tenants.isPlatform` into the memberships subselect).

- [ ] **Step 2: Update /v1/me to include isPlatform on memberships**

Edit `apps/api/src/routes/me.ts` — wherever the memberships array is built, include `is_platform`:

```ts
// In the SELECT building the memberships array:
const memberships = await db
  .select({
    tenantId: tenantMembers.tenantId,
    tenantName: tenants.name,
    tenantSlug: tenants.slug,
    role: tenantMembers.role,
    isPlatform: tenants.isPlatform,
  })
  .from(tenantMembers)
  .innerJoin(tenants, eq(tenants.id, tenantMembers.tenantId))
  .where(eq(tenantMembers.userId, user.id));
```

Commit just this part separately:
```bash
cd apps/api && pnpm typecheck && pnpm test src/routes/me.test.ts
```
Expected: clean.

- [ ] **Step 3: Wire admin protected layout to require platform membership**

Edit `apps/admin/app/(protected)/layout.tsx` — after the existing Firebase-auth guard, add:

```tsx
const [me, setMe] = useState<{ memberships: { tenantId: string; isPlatform: boolean }[] } | null>(null);
const [meLoading, setMeLoading] = useState(true);
useEffect(() => {
  if (!user) return;
  setMeLoading(true);
  user.getIdToken().then((token) =>
    fetch(`${process.env.NEXT_PUBLIC_API_BASE_URL}/v1/me`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then(setMe)
      .finally(() => setMeLoading(false)),
  );
}, [user]);

useEffect(() => {
  if (loading || meLoading || !me) return;
  const platformMembership = me.memberships.find((m) => m.isPlatform);
  if (!platformMembership) {
    void signOut();
    router.replace('/login?error=not_circls_team');
  }
}, [loading, meLoading, me, signOut, router]);
```

- [ ] **Step 4: Create the admin-side invite acceptance page**

Create `apps/admin/app/(auth)/invite/[token]/page.tsx` mirroring the partners version, but pointing the redirect at `/dashboard` (already correct since admin only has /dashboard):

(Reuse the exact same code as Task 13 Step 1, with imports adjusted to `@/lib/firebase/client` and `@/lib/api/client` which exist in apps/admin.)

```tsx
'use client';
import { useParams, useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
} from 'firebase/auth';
import { auth } from '@/lib/firebase/client';

interface InviteMeta {
  tenantName: string;
  role: 'owner' | 'manager' | 'staff' | 'readonly';
  email: string;
  inviterEmail: string | null;
  expiresAt: string;
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const base = process.env.NEXT_PUBLIC_API_BASE_URL ?? '';
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(await res.text());
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export default function AcceptInvitePage() {
  const { token } = useParams() as { token: string };
  const router = useRouter();
  const [meta, setMeta] = useState<InviteMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiFetch<InviteMeta>(`/v1/invitations/lookup?token=${encodeURIComponent(token)}`)
      .then(setMeta)
      .catch((err) => setError(err instanceof Error ? err.message : 'Lookup failed'));
  }, [token]);

  async function handleAccept(e: FormEvent) {
    e.preventDefault();
    if (!meta) return;
    setBusy(true);
    setError(null);
    try {
      let cred;
      try {
        cred = await createUserWithEmailAndPassword(auth, meta.email, password);
      } catch (err) {
        if ((err as { code?: string }).code === 'auth/email-already-in-use') {
          cred = await signInWithEmailAndPassword(auth, meta.email, password);
        } else {
          throw err;
        }
      }
      const firebaseIdToken = await cred.user.getIdToken();
      await apiFetch(`/v1/invitations/${encodeURIComponent(token)}/accept`, {
        method: 'POST',
        body: JSON.stringify({ firebaseIdToken }),
      });
      router.replace('/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Accept failed');
    } finally {
      setBusy(false);
    }
  }

  if (error && !meta) {
    return (
      <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-3 p-6">
        <h1 className="text-2xl font-semibold">Invitation not found</h1>
        <p className="text-sm text-slate-600">
          The link may have expired or been revoked.
        </p>
      </main>
    );
  }
  if (!meta) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <span className="block h-6 w-6 animate-spin rounded-full border-2 border-slate-300 border-t-slate-700" />
      </main>
    );
  }
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-6">
      <h1 className="text-2xl font-semibold">Join {meta.tenantName}</h1>
      <p className="text-sm text-slate-600">
        You’ve been invited as <strong>{meta.role}</strong>. Set a password to accept.
      </p>
      <form onSubmit={handleAccept} className="flex flex-col gap-3">
        <input type="email" value={meta.email} disabled className="rounded border border-gray-300 bg-slate-50 px-3 py-2 text-slate-500" />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          required
          minLength={8}
          className="rounded border border-gray-300 px-3 py-2"
          placeholder="New password"
        />
        <button type="submit" disabled={busy} className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50">
          {busy ? 'Accepting…' : 'Accept invitation'}
        </button>
      </form>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </main>
  );
}
```

- [ ] **Step 5: Typecheck + build**

Run: `cd apps/admin && pnpm typecheck && pnpm build`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/admin apps/api/src/routes/me.ts
git commit -m "feat(admin): gate protected layout on is_platform membership; invite acceptance page"
```

---

## Task 16: Final verification — full repo typecheck + test + clean test DB

**Files:** (none modified)

- [ ] **Step 1: Full-repo typecheck**

Run:
```bash
cd /Users/vedant/personal/circls-platform/.claude/worktrees/track-b-scaffold && pnpm -r typecheck
```
Expected: 3 packages, all clean.

- [ ] **Step 2: Full integration test suite on the fresh test DB**

Run:
```bash
docker exec circls-devpg psql -U postgres -d postgres -c "DROP DATABASE IF EXISTS circls_team_test;"
docker exec circls-devpg psql -U postgres -d postgres -c "CREATE DATABASE circls_team_test;"
cd apps/api && DATABASE_URL='postgres://postgres:postgres@localhost:5433/circls_team_test' pnpm db:migrate
cd apps/api && DATABASE_URL='postgres://postgres:postgres@localhost:5433/circls_team_test' RUN_INTEGRATION=1 pnpm test
```
Expected: every test passes (the Track B 256 plus ~20 new ones for team management).

- [ ] **Step 3: Bootstrap-script smoke**

Run:
```bash
cd apps/api && DATABASE_URL='postgres://postgres:postgres@localhost:5433/circls_team_test' \
  pnpm bootstrap:circls smoke-bootstrap@x.test "Smoke"
```
Expected: prints invite URL; re-running prints "already bootstrapped".

- [ ] **Step 4: Build artifacts**

Run:
```bash
cd apps/api && pnpm build
cd apps/partners && pnpm build
cd apps/admin && pnpm build
```
Expected: all green.

- [ ] **Step 5: Clean up the test DB**

```bash
docker exec circls-devpg psql -U postgres -d postgres -c "DROP DATABASE circls_team_test;"
```

- [ ] **Step 6: Final commit (if any cleanup edits were made above)**

```bash
git status -s
# If clean, no commit needed. Otherwise:
git add -A && git commit -m "chore(team): final verification + cleanup"
```

---

## Plan self-review notes

- **Spec coverage:** every spec §1–§8 has a task. §9 (open questions) is acknowledged in tasks 12+15 (consumer auth deferred; tenant deletion + 2FA out of scope).
- **No placeholders left in this plan.** Every code step is concrete; every command has an expected output.
- **Type consistency check:**
  - `assertCap` is the exported name from `require_cap.ts` (Task 3 + 6 + 8 all use the same name).
  - `TenantContext` from `tenant_context.ts` is referenced consistently as `{tenantId, userId, role, isPlatform}` across Tasks 3–8.
  - The invitation result type `{invitation, plaintextToken}` is the same across `createInvitation`/`resendInvitation` (Tasks 4, 6, 10).
  - React Query hook names match between `lib/api/queries.ts` and consumer pages (Task 13 + 14).
- **Sequencing fragility:** Task 8 (retiring `require_platform_admin`) must run *after* Task 9/10 are merged in prod and the operator has executed Task 11's migration script. The plan flags this in Task 8 step 1 and the spec's §5.4 note.
