# Coupon Codes + Transparent Checkout — Backend Implementation Plan (Plan 1 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the backend foundation for discount coupons + transparent (Razorpay-fee-grossed-up) checkout in `apps/api`: data model, a pure checkout-pricing module, coupon CRUD for orgs and platform admins, code validation, a consumer quote endpoint, booking integration that records redemptions, and the payout settle-base change.

**Architecture:** A single pure `computeCheckout` module is the one source of pricing truth, used by both the consumer quote endpoint and the authoritative booking path so client and server can never diverge. Coupons live in a `coupons` table (platform- or tenant-owned, single-scope) with redemptions in `coupon_redemptions`. The grossed-up total is what the customer pays; an immutable `payments.settle_base_paise` records the org-settleable base so the existing weekly payout reconciliation pays the org the right amount with one query change.

**Tech Stack:** Fastify, Drizzle ORM (Postgres 18, `uuidv7()`), Zod, Vitest. Integration tests gate on `RUN_INTEGRATION` + a real DB (mirroring existing `*.test.ts`); pure-logic tests always run.

Spec: `docs/superpowers/specs/2026-06-08-coupons-transparent-checkout-design.md`.

This is **Plan 1 of 4**. Plans 2–4 (Partners/Admin UI, Web consumer modal, Flutter consumer modal) bind to the endpoints and types defined here and should be written after this lands.

---

## File Structure

**Create:**
- `apps/api/src/services/checkout_pricing.ts` — pure pricing math (`RAZORPAY_FEE_RATE`, `grossUp`, `computeDiscountPaise`, `computeCheckout`).
- `apps/api/src/services/checkout_pricing.test.ts` — pure unit tests (always run).
- `apps/api/src/db/schema/coupons.ts` — `coupons` table + enums + types.
- `apps/api/src/db/schema/coupon_redemptions.ts` — `coupon_redemptions` table + `coupon_funder` enum + types.
- `apps/api/src/db/migrations/0022_coupons.sql` — DDL.
- `apps/api/src/services/coupon_service.ts` — CRUD + `resolveCouponForCheckout` + `validateCoupon` (pure) + redemption helper.
- `apps/api/src/services/coupon_service.validate.test.ts` — pure validation unit tests (always run).
- `apps/api/src/routes/coupons.ts` — org routes `/v1/tenants/:tenantId/coupons` + admin routes `/v1/admin/coupons`.
- `apps/api/src/routes/coupons.test.ts` — integration tests (gated).
- `apps/api/src/routes/checkout.ts` — consumer `/v1/consumer/checkout/quote` + `/v1/consumer/coupons`.
- `apps/api/src/routes/checkout.test.ts` — integration tests (gated).

**Modify:**
- `apps/api/src/db/schema/index.ts` — export the two new schema modules.
- `apps/api/src/db/migrations/meta/_journal.json` — add the `0022_coupons` journal entry.
- `apps/api/src/lib/authz/capabilities.ts` — add `discounts.read`, `discounts.write`, `admin.coupons.read`, `admin.coupons.write`.
- `apps/api/src/lib/authz/role_caps.ts` — grant the new caps.
- `apps/api/src/services/payments_service.ts` — `createRouteOrder` accepts + persists `settleBasePaise`.
- `apps/api/src/services/payout_service.ts` — gross query sums `settle_base_paise`.
- `apps/api/src/services/consumer_service.ts` — `consumerBookSlots/Event/PurchaseMembership` accept `couponCode`.
- `apps/api/src/services/booking_service.ts` — `prepareOnlineBookingWithPayment` + `bookEvent` apply coupon, set settle base, record redemption.
- `apps/api/src/services/memberships_service.ts` — `purchaseMembership` applies coupon (same pattern as event).
- `apps/api/src/routes/consumer.ts` — accept `couponCode` in the three book/purchase bodies.
- `apps/api/src/server.ts` — register `couponRoutes` + `checkoutRoutes`.

---

## Task 1: Checkout pricing core (pure)

**Files:**
- Create: `apps/api/src/services/checkout_pricing.ts`
- Test: `apps/api/src/services/checkout_pricing.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/api/src/services/checkout_pricing.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  RAZORPAY_FEE_RATE,
  computeCheckout,
  computeDiscountPaise,
  grossUp,
} from './checkout_pricing.js';

describe('grossUp', () => {
  it('grosses up to recover the Razorpay fee, rounding up', () => {
    // 50000 / (1 - 0.0236) = 51208.52… → ceil 51209
    expect(grossUp(50000)).toBe(51209);
  });
  it('returns 0 for a zero or negative base', () => {
    expect(grossUp(0)).toBe(0);
    expect(grossUp(-10)).toBe(0);
  });
  it('uses the 2.36% rate constant', () => {
    expect(RAZORPAY_FEE_RATE).toBe(0.0236);
  });
});

describe('computeDiscountPaise', () => {
  it('computes a percentage discount in basis points, floored to whole paise', () => {
    expect(computeDiscountPaise(50000, { discountType: 'percent', discountValue: 1000, maxDiscountPaise: null })).toBe(5000);
  });
  it('caps a percentage discount at maxDiscountPaise', () => {
    expect(computeDiscountPaise(50000, { discountType: 'percent', discountValue: 1000, maxDiscountPaise: 3000 })).toBe(3000);
  });
  it('applies a fixed discount in paise', () => {
    expect(computeDiscountPaise(50000, { discountType: 'fixed', discountValue: 5000, maxDiscountPaise: null })).toBe(5000);
  });
  it('never discounts more than the base', () => {
    expect(computeDiscountPaise(50000, { discountType: 'fixed', discountValue: 60000, maxDiscountPaise: null })).toBe(50000);
  });
});

describe('computeCheckout', () => {
  it('grosses up the base when there is no coupon', () => {
    expect(computeCheckout(50000, null)).toEqual({
      basePaise: 50000,
      discountPaise: 0,
      discountedBasePaise: 50000,
      otherChargesPaise: 1209,
      totalPaise: 51209,
    });
  });
  it('applies the discount to the base, then grosses up the reduced base', () => {
    expect(computeCheckout(50000, { discountType: 'percent', discountValue: 1000, maxDiscountPaise: null })).toEqual({
      basePaise: 50000,
      discountPaise: 5000,
      discountedBasePaise: 45000,
      otherChargesPaise: 1088,
      totalPaise: 46088,
    });
  });
  it('yields a free total when the discount covers the whole base', () => {
    expect(computeCheckout(50000, { discountType: 'fixed', discountValue: 60000, maxDiscountPaise: null })).toEqual({
      basePaise: 50000,
      discountPaise: 50000,
      discountedBasePaise: 0,
      otherChargesPaise: 0,
      totalPaise: 0,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && pnpm vitest run src/services/checkout_pricing.test.ts`
Expected: FAIL — `Cannot find module './checkout_pricing.js'`.

- [ ] **Step 3: Write the implementation**

`apps/api/src/services/checkout_pricing.ts`:

```ts
/**
 * Checkout pricing — the single source of truth for the money model.
 *
 * Customers pay a base price grossed up to recover Razorpay's fee, less any
 * coupon discount. Used by BOTH the consumer quote endpoint and the
 * authoritative booking path so the two can never diverge. See
 * docs/superpowers/specs/2026-06-08-coupons-transparent-checkout-design.md.
 */

/** Razorpay fee incl. GST on the fee. The only add-on; there is no separate ticket GST. */
export const RAZORPAY_FEE_RATE = 0.0236;

/** The coupon fields needed to price a discount (a slice of the coupons row). */
export interface CouponForPricing {
  discountType: 'percent' | 'fixed';
  /** Basis points (100 = 1%) when percent; paise when fixed. */
  discountValue: number;
  /** Cap for percent coupons, in paise; null = uncapped. Ignored for fixed. */
  maxDiscountPaise: number | null;
}

/**
 * Gross an amount up so that, after Razorpay deducts its fee, we net the input.
 * `ceil` so we never under-net the base. Non-positive input → 0 (free).
 */
export function grossUp(amountPaise: number): number {
  if (amountPaise <= 0) return 0;
  return Math.ceil(amountPaise / (1 - RAZORPAY_FEE_RATE));
}

/** The discount in paise for `basePaise`, floored at whole paise and capped at the base. */
export function computeDiscountPaise(basePaise: number, coupon: CouponForPricing): number {
  let discount: number;
  if (coupon.discountType === 'percent') {
    discount = Math.floor((basePaise * coupon.discountValue) / 10_000);
    if (coupon.maxDiscountPaise != null) discount = Math.min(discount, coupon.maxDiscountPaise);
  } else {
    discount = coupon.discountValue;
  }
  return Math.max(0, Math.min(discount, basePaise));
}

export interface CheckoutBreakdown {
  basePaise: number;
  discountPaise: number;
  discountedBasePaise: number;
  /** total − discountedBase: the "Other charges (incl taxes)" line. */
  otherChargesPaise: number;
  /** What the customer pays. 0 ⇒ free, skip Razorpay. */
  totalPaise: number;
}

/** Full breakdown for a base price and an optional coupon. */
export function computeCheckout(
  basePaise: number,
  coupon: CouponForPricing | null,
): CheckoutBreakdown {
  const discountPaise = coupon ? computeDiscountPaise(basePaise, coupon) : 0;
  const discountedBasePaise = Math.max(0, basePaise - discountPaise);
  const totalPaise = grossUp(discountedBasePaise);
  return {
    basePaise,
    discountPaise,
    discountedBasePaise,
    otherChargesPaise: totalPaise - discountedBasePaise,
    totalPaise,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && pnpm vitest run src/services/checkout_pricing.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/checkout_pricing.ts apps/api/src/services/checkout_pricing.test.ts
git commit -m "feat(api): checkout pricing module — Razorpay gross-up + coupon discount"
```

---

## Task 2: Coupon schema + types

**Files:**
- Create: `apps/api/src/db/schema/coupons.ts`
- Create: `apps/api/src/db/schema/coupon_redemptions.ts`
- Modify: `apps/api/src/db/schema/index.ts`

- [ ] **Step 1: Write `coupons.ts`**

`apps/api/src/db/schema/coupons.ts`:

```ts
import { bigint, integer, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { bigintPaise, createdAt, updatedAt, uuidPk } from './_columns.js';
import { tenants } from './tenants.js';

/** Who created the coupon. Platform coupons are Circls-funded; tenant coupons org-funded. */
export const couponOwnerType = pgEnum('coupon_owner_type', ['platform', 'tenant']);
/** A coupon targets exactly one scope. `org` = whole owner; others use scope_id. */
export const couponScopeType = pgEnum('coupon_scope_type', [
  'org',
  'venue',
  'event',
  'arena',
  'membership',
]);
export const couponDiscountType = pgEnum('coupon_discount_type', ['percent', 'fixed']);
/** public = listable at checkout; private = must be typed. */
export const couponVisibility = pgEnum('coupon_visibility', ['public', 'private']);
export const couponStatus = pgEnum('coupon_status', ['active', 'paused', 'expired']);

export const coupons = pgTable('coupons', {
  id: uuidPk(),
  ownerType: couponOwnerType('owner_type').notNull(),
  /** Set for tenant-owned; null for platform-owned. */
  tenantId: uuid('tenant_id').references(() => tenants.id),
  code: text('code').notNull(),
  description: text('description'),
  scopeType: couponScopeType('scope_type').notNull(),
  /** venue/event/arena/membership id; null for `org` and platform-wide scope. */
  scopeId: uuid('scope_id'),
  discountType: couponDiscountType('discount_type').notNull(),
  /** Basis points when percent; paise when fixed. */
  discountValue: bigint('discount_value', { mode: 'number' }).notNull(),
  maxDiscountPaise: bigintPaise('max_discount_paise'),
  minOrderPaise: bigintPaise('min_order_paise'),
  visibility: couponVisibility('visibility').notNull().default('private'),
  validFrom: timestamp('valid_from', { withTimezone: true }),
  validUntil: timestamp('valid_until', { withTimezone: true }),
  maxRedemptions: integer('max_redemptions'),
  perUserLimit: integer('per_user_limit'),
  redeemedCount: integer('redeemed_count').notNull().default(0),
  status: couponStatus('status').notNull().default('active'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type Coupon = typeof coupons.$inferSelect;
export type NewCoupon = typeof coupons.$inferInsert;
```

- [ ] **Step 2: Write `coupon_redemptions.ts`**

`apps/api/src/db/schema/coupon_redemptions.ts`:

```ts
import { pgEnum, pgTable, uuid } from 'drizzle-orm/pg-core';
import { bigintPaise, createdAt, uuidPk } from './_columns.js';
import { bookings } from './bookings.js';
import { coupons } from './coupons.js';
import { tenants } from './tenants.js';
import { users } from './users.js';

/** Who absorbs the discount — drives nothing in payout math directly (that reads
 *  payments.settle_base_paise) but is recorded for audit/analytics. */
export const couponFunder = pgEnum('coupon_funder', ['org', 'platform']);

export const couponRedemptions = pgTable('coupon_redemptions', {
  id: uuidPk(),
  couponId: uuid('coupon_id')
    .notNull()
    .references(() => coupons.id),
  bookingId: uuid('booking_id')
    .notNull()
    .references(() => bookings.id),
  userId: uuid('user_id').references(() => users.id),
  /** The org whose item was purchased. */
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  basePaise: bigintPaise('base_paise').notNull(),
  discountPaise: bigintPaise('discount_paise').notNull(),
  funder: couponFunder('funder').notNull(),
  createdAt: createdAt(),
});

export type CouponRedemption = typeof couponRedemptions.$inferSelect;
export type NewCouponRedemption = typeof couponRedemptions.$inferInsert;
```

- [ ] **Step 3: Export from the schema barrel**

In `apps/api/src/db/schema/index.ts`, add exports alongside the existing ones (match the file's existing `export * from './<name>.js';` style):

```ts
export * from './coupons.js';
export * from './coupon_redemptions.js';
```

- [ ] **Step 4: Typecheck**

Run: `cd apps/api && pnpm typecheck`
Expected: PASS (no type errors from the new modules).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/schema/coupons.ts apps/api/src/db/schema/coupon_redemptions.ts apps/api/src/db/schema/index.ts
git commit -m "feat(api): coupons + coupon_redemptions schema"
```

---

## Task 3: Migration 0022

**Files:**
- Create: `apps/api/src/db/migrations/0022_coupons.sql`
- Modify: `apps/api/src/db/migrations/meta/_journal.json`

- [ ] **Step 1: Write the migration SQL**

`apps/api/src/db/migrations/0022_coupons.sql`:

```sql
CREATE TYPE "public"."coupon_owner_type" AS ENUM('platform', 'tenant');--> statement-breakpoint
CREATE TYPE "public"."coupon_scope_type" AS ENUM('org', 'venue', 'event', 'arena', 'membership');--> statement-breakpoint
CREATE TYPE "public"."coupon_discount_type" AS ENUM('percent', 'fixed');--> statement-breakpoint
CREATE TYPE "public"."coupon_visibility" AS ENUM('public', 'private');--> statement-breakpoint
CREATE TYPE "public"."coupon_status" AS ENUM('active', 'paused', 'expired');--> statement-breakpoint
CREATE TYPE "public"."coupon_funder" AS ENUM('org', 'platform');--> statement-breakpoint
CREATE TABLE "coupons" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"owner_type" "coupon_owner_type" NOT NULL,
	"tenant_id" uuid,
	"code" text NOT NULL,
	"description" text,
	"scope_type" "coupon_scope_type" NOT NULL,
	"scope_id" uuid,
	"discount_type" "coupon_discount_type" NOT NULL,
	"discount_value" bigint NOT NULL,
	"max_discount_paise" bigint,
	"min_order_paise" bigint,
	"visibility" "coupon_visibility" DEFAULT 'private' NOT NULL,
	"valid_from" timestamp with time zone,
	"valid_until" timestamp with time zone,
	"max_redemptions" integer,
	"per_user_limit" integer,
	"redeemed_count" integer DEFAULT 0 NOT NULL,
	"status" "coupon_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coupon_redemptions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"coupon_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"user_id" uuid,
	"tenant_id" uuid NOT NULL,
	"base_paise" bigint NOT NULL,
	"discount_paise" bigint NOT NULL,
	"funder" "coupon_funder" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_coupon_id_coupons_id_fk" FOREIGN KEY ("coupon_id") REFERENCES "public"."coupons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "coupons_platform_code_uq" ON "coupons" ("code") WHERE "owner_type" = 'platform';--> statement-breakpoint
CREATE UNIQUE INDEX "coupons_tenant_code_uq" ON "coupons" ("tenant_id","code") WHERE "owner_type" = 'tenant';--> statement-breakpoint
CREATE INDEX "coupons_tenant_idx" ON "coupons" ("tenant_id");--> statement-breakpoint
CREATE INDEX "coupons_owner_idx" ON "coupons" ("owner_type");--> statement-breakpoint
CREATE INDEX "coupons_scope_idx" ON "coupons" ("scope_type","scope_id");--> statement-breakpoint
CREATE UNIQUE INDEX "coupon_redemptions_coupon_booking_uq" ON "coupon_redemptions" ("coupon_id","booking_id");--> statement-breakpoint
CREATE INDEX "coupon_redemptions_coupon_user_idx" ON "coupon_redemptions" ("coupon_id","user_id");--> statement-breakpoint
CREATE INDEX "coupon_redemptions_tenant_funder_idx" ON "coupon_redemptions" ("tenant_id","funder","created_at");--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "coupon_id" uuid;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "discount_paise" bigint DEFAULT 0;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "base_paise" bigint;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_coupon_id_coupons_id_fk" FOREIGN KEY ("coupon_id") REFERENCES "public"."coupons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "settle_base_paise" bigint;
```

- [ ] **Step 2: Add the journal entry**

In `apps/api/src/db/migrations/meta/_journal.json`, append to the `entries` array (after the `idx: 21` object — add a comma after it):

```json
    {
      "idx": 22,
      "version": "7",
      "when": 1780800000000,
      "tag": "0022_coupons",
      "breakpoints": true
    }
```

- [ ] **Step 3: Add the schema columns to the Drizzle models for bookings & payments**

The migration adds columns; the Drizzle table definitions must match or selects of the new columns fail. Edit `apps/api/src/db/schema/bookings.ts` — add inside the `bookings` table object, after `totalPaise`:

```ts
  basePaise: bigintPaise('base_paise'),
  discountPaise: bigintPaise('discount_paise').default(0),
  couponId: uuid('coupon_id').references(() => coupons.id),
```

…and add the import at the top of `bookings.ts`:

```ts
import { coupons } from './coupons.js';
```

Edit `apps/api/src/db/schema/payments.ts` — add a settle-base column next to the existing `amountPaise` (use the same `bigintPaise` helper the file already imports; if not imported, add it):

```ts
  settleBasePaise: bigintPaise('settle_base_paise'),
```

- [ ] **Step 4: Apply the migration against a local DB and verify**

Run: `cd apps/api && pnpm db:migrate`
Expected: logs `migrations_applied`, no error. (Requires `DATABASE_URL` to a local Postgres 18.)

Then verify the columns exist:

Run: `cd apps/api && psql "$DATABASE_URL" -c "\d coupons" -c "\d coupon_redemptions" -c "select column_name from information_schema.columns where table_name='payments' and column_name='settle_base_paise';"`
Expected: both tables print; the `settle_base_paise` row is returned.

- [ ] **Step 5: Typecheck**

Run: `cd apps/api && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/db/migrations/0022_coupons.sql apps/api/src/db/migrations/meta/_journal.json apps/api/src/db/schema/bookings.ts apps/api/src/db/schema/payments.ts
git commit -m "feat(api): migration 0022 — coupons, redemptions, booking + payment columns"
```

---

## Task 4: Coupon validation (pure)

Validation splits into a **pure** part (status/window/scope/min-order/total-cap given the row) and a DB-backed part (per-user count), so the core logic is unit-tested without a DB. This task does the pure part + its tests.

**Files:**
- Create: `apps/api/src/services/coupon_service.ts` (validation section only; CRUD added in Task 5)
- Test: `apps/api/src/services/coupon_service.validate.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/api/src/services/coupon_service.validate.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { validateCoupon, type CouponValidationContext } from './coupon_service.js';
import type { Coupon } from '../db/schema/coupons.js';

const NOW = new Date('2026-06-08T12:00:00.000Z');

function coupon(overrides: Partial<Coupon> = {}): Coupon {
  return {
    id: 'c1',
    ownerType: 'tenant',
    tenantId: 't1',
    code: 'SUMMER10',
    description: null,
    scopeType: 'org',
    scopeId: null,
    discountType: 'percent',
    discountValue: 1000,
    maxDiscountPaise: null,
    minOrderPaise: null,
    visibility: 'public',
    validFrom: null,
    validUntil: null,
    maxRedemptions: null,
    perUserLimit: null,
    redeemedCount: 0,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
  } as Coupon;
}

const ctx = (over: Partial<CouponValidationContext> = {}): CouponValidationContext => ({
  basePaise: 50000,
  now: NOW,
  item: { type: 'event', id: 'e1', venueId: 'v1' },
  ...over,
});

describe('validateCoupon (pure)', () => {
  it('accepts an active, in-window, org-scoped coupon', () => {
    expect(validateCoupon(coupon(), ctx())).toEqual({ ok: true });
  });
  it('rejects a paused coupon', () => {
    expect(validateCoupon(coupon({ status: 'paused' }), ctx())).toEqual({ ok: false, code: 'coupon_inactive' });
  });
  it('rejects before valid_from', () => {
    expect(validateCoupon(coupon({ validFrom: new Date('2026-07-01T00:00:00Z') }), ctx())).toEqual({ ok: false, code: 'coupon_not_started' });
  });
  it('rejects after valid_until', () => {
    expect(validateCoupon(coupon({ validUntil: new Date('2026-06-01T00:00:00Z') }), ctx())).toEqual({ ok: false, code: 'coupon_expired' });
  });
  it('rejects when base is below min_order_paise', () => {
    expect(validateCoupon(coupon({ minOrderPaise: 60000 }), ctx())).toEqual({ ok: false, code: 'coupon_min_order' });
  });
  it('rejects when total redemptions are exhausted', () => {
    expect(validateCoupon(coupon({ maxRedemptions: 5, redeemedCount: 5 }), ctx())).toEqual({ ok: false, code: 'coupon_max_redeemed' });
  });
  it('rejects a venue-scoped coupon when the item is at a different venue', () => {
    expect(validateCoupon(coupon({ scopeType: 'venue', scopeId: 'v2' }), ctx())).toEqual({ ok: false, code: 'coupon_scope_mismatch' });
  });
  it('accepts a venue-scoped coupon when the item is at that venue', () => {
    expect(validateCoupon(coupon({ scopeType: 'venue', scopeId: 'v1' }), ctx())).toEqual({ ok: true });
  });
  it('rejects an event-scoped coupon when the item id differs', () => {
    expect(validateCoupon(coupon({ scopeType: 'event', scopeId: 'e2' }), ctx())).toEqual({ ok: false, code: 'coupon_scope_mismatch' });
  });
  it('accepts an event-scoped coupon for the matching event', () => {
    expect(validateCoupon(coupon({ scopeType: 'event', scopeId: 'e1' }), ctx())).toEqual({ ok: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && pnpm vitest run src/services/coupon_service.validate.test.ts`
Expected: FAIL — `coupon_service.js` has no `validateCoupon` export.

- [ ] **Step 3: Write the validation core**

Create `apps/api/src/services/coupon_service.ts` (CRUD functions appended in Task 5):

```ts
/**
 * Coupon service — CRUD (Task 5) plus the validation + resolution used at
 * checkout. `validateCoupon` is pure (no DB) so the constraint logic is unit
 * tested directly; the per-user redemption count + code resolution that need
 * the DB live in `resolveCouponForCheckout` (Task 10 wires it into booking).
 */
import type { Coupon } from '../db/schema/coupons.js';

/** The item being purchased, used for scope matching. */
export interface CheckoutItem {
  type: 'slot' | 'event' | 'arena' | 'membership';
  /** The event/membership id, or the arena id for a slot booking. */
  id: string;
  /** The venue the item belongs to, if any (null for org-scoped events). */
  venueId: string | null;
}

export interface CouponValidationContext {
  basePaise: number;
  now: Date;
  item: CheckoutItem;
}

export type CouponErrorCode =
  | 'coupon_not_found'
  | 'coupon_inactive'
  | 'coupon_not_started'
  | 'coupon_expired'
  | 'coupon_scope_mismatch'
  | 'coupon_min_order'
  | 'coupon_max_redeemed'
  | 'coupon_user_limit';

export type CouponValidationResult = { ok: true } | { ok: false; code: CouponErrorCode };

/** Does this coupon's scope cover the item being purchased? */
export function couponMatchesItem(coupon: Coupon, item: CheckoutItem): boolean {
  switch (coupon.scopeType) {
    case 'org':
      return true; // owner-wide (tenant) or platform-wide
    case 'venue':
      return item.venueId != null && item.venueId === coupon.scopeId;
    case 'arena':
      return item.type === 'slot' && item.id === coupon.scopeId;
    case 'event':
      return item.type === 'event' && item.id === coupon.scopeId;
    case 'membership':
      return item.type === 'membership' && item.id === coupon.scopeId;
    default:
      return false;
  }
}

/**
 * Pure constraint check: status, window, scope, min-order, total-cap. Does NOT
 * check the per-user limit (needs a DB count — done in resolveCouponForCheckout).
 */
export function validateCoupon(
  coupon: Coupon,
  ctx: CouponValidationContext,
): CouponValidationResult {
  if (coupon.status !== 'active') return { ok: false, code: 'coupon_inactive' };
  if (coupon.validFrom && ctx.now < coupon.validFrom) return { ok: false, code: 'coupon_not_started' };
  if (coupon.validUntil && ctx.now > coupon.validUntil) return { ok: false, code: 'coupon_expired' };
  if (!couponMatchesItem(coupon, ctx.item)) return { ok: false, code: 'coupon_scope_mismatch' };
  if (coupon.minOrderPaise != null && ctx.basePaise < coupon.minOrderPaise) {
    return { ok: false, code: 'coupon_min_order' };
  }
  if (coupon.maxRedemptions != null && coupon.redeemedCount >= coupon.maxRedemptions) {
    return { ok: false, code: 'coupon_max_redeemed' };
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && pnpm vitest run src/services/coupon_service.validate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/coupon_service.ts apps/api/src/services/coupon_service.validate.test.ts
git commit -m "feat(api): coupon validation core (pure)"
```

---

## Task 5: Coupon CRUD + resolution (DB)

**Files:**
- Modify: `apps/api/src/services/coupon_service.ts`

- [ ] **Step 1: Append CRUD + resolution to `coupon_service.ts`**

Add these imports to the top of `apps/api/src/services/coupon_service.ts`:

```ts
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { coupons, type NewCoupon } from '../db/schema/coupons.js';
import { couponRedemptions } from '../db/schema/coupon_redemptions.js';
import { writeAudit, type AuditCtx } from '../lib/audit.js';
import { BadRequest, Conflict, NotFound } from '../lib/errors.js';
```

Append:

```ts
/** Owner selector: a tenant id for org coupons, or `'platform'`. */
export type CouponOwner = { kind: 'tenant'; tenantId: string } | { kind: 'platform' };

export interface CreateCouponInput {
  code: string;
  description?: string | null;
  scopeType: Coupon['scopeType'];
  scopeId?: string | null;
  discountType: Coupon['discountType'];
  discountValue: number;
  maxDiscountPaise?: number | null;
  minOrderPaise?: number | null;
  visibility?: Coupon['visibility'];
  validFrom?: Date | null;
  validUntil?: Date | null;
  maxRedemptions?: number | null;
  perUserLimit?: number | null;
}

function assertScopeShape(input: { scopeType: Coupon['scopeType']; scopeId?: string | null }): void {
  const needsId = input.scopeType !== 'org';
  if (needsId && !input.scopeId) {
    throw new BadRequest('This scope requires a scopeId', 'coupon_scope_id_required');
  }
  if (!needsId && input.scopeId) {
    throw new BadRequest('org scope must not have a scopeId', 'coupon_scope_id_unexpected');
  }
}

export async function createCoupon(
  ctx: AuditCtx,
  owner: CouponOwner,
  input: CreateCouponInput,
): Promise<Coupon> {
  assertScopeShape(input);
  if (input.discountType === 'percent' && (input.discountValue <= 0 || input.discountValue > 10_000)) {
    throw new BadRequest('Percent discount must be 1–10000 bps', 'coupon_bad_percent');
  }
  if (input.discountType === 'fixed' && input.discountValue <= 0) {
    throw new BadRequest('Fixed discount must be positive', 'coupon_bad_fixed');
  }
  const values: NewCoupon = {
    ownerType: owner.kind === 'tenant' ? 'tenant' : 'platform',
    tenantId: owner.kind === 'tenant' ? owner.tenantId : null,
    code: input.code.trim(),
    description: input.description ?? null,
    scopeType: input.scopeType,
    scopeId: input.scopeId ?? null,
    discountType: input.discountType,
    discountValue: input.discountValue,
    maxDiscountPaise: input.maxDiscountPaise ?? null,
    minOrderPaise: input.minOrderPaise ?? null,
    visibility: input.visibility ?? 'private',
    validFrom: input.validFrom ?? null,
    validUntil: input.validUntil ?? null,
    maxRedemptions: input.maxRedemptions ?? null,
    perUserLimit: input.perUserLimit ?? null,
  };
  return db.transaction(async (tx) => {
    let row: Coupon | undefined;
    try {
      [row] = await tx.insert(coupons).values(values).returning();
    } catch (err) {
      if (err instanceof Error && err.message.includes('uq')) {
        throw new Conflict('A coupon with this code already exists', 'coupon_code_taken');
      }
      throw err;
    }
    if (!row) throw new Error('coupon insert returned no row');
    await writeAudit(tx, ctx, 'coupon.created', 'coupon', row.id, null, {
      code: row.code,
      scopeType: row.scopeType,
      discountType: row.discountType,
      discountValue: row.discountValue,
    });
    return row;
  });
}

export async function listCoupons(owner: CouponOwner): Promise<Coupon[]> {
  const where =
    owner.kind === 'tenant'
      ? and(eq(coupons.ownerType, 'tenant'), eq(coupons.tenantId, owner.tenantId))
      : eq(coupons.ownerType, 'platform');
  return db.select().from(coupons).where(where).orderBy(sql`${coupons.createdAt} desc`);
}

/** Owner-scoped fetch so a tenant can never read/patch another owner's coupon. */
export async function getOwnedCoupon(owner: CouponOwner, couponId: string): Promise<Coupon | null> {
  const where =
    owner.kind === 'tenant'
      ? and(eq(coupons.id, couponId), eq(coupons.ownerType, 'tenant'), eq(coupons.tenantId, owner.tenantId))
      : and(eq(coupons.id, couponId), eq(coupons.ownerType, 'platform'));
  const [row] = await db.select().from(coupons).where(where).limit(1);
  return row ?? null;
}

export interface UpdateCouponPatch {
  description?: string | null;
  minOrderPaise?: number | null;
  maxDiscountPaise?: number | null;
  visibility?: Coupon['visibility'];
  validFrom?: Date | null;
  validUntil?: Date | null;
  maxRedemptions?: number | null;
  perUserLimit?: number | null;
  status?: Coupon['status'];
}

export async function updateCoupon(
  ctx: AuditCtx,
  owner: CouponOwner,
  couponId: string,
  patch: UpdateCouponPatch,
): Promise<Coupon> {
  return db.transaction(async (tx) => {
    const existing = await getOwnedCoupon(owner, couponId);
    if (!existing) throw new NotFound('Coupon not found', 'coupon_not_found');
    const set: Partial<NewCoupon> = {};
    for (const k of [
      'description', 'minOrderPaise', 'maxDiscountPaise', 'visibility',
      'validFrom', 'validUntil', 'maxRedemptions', 'perUserLimit', 'status',
    ] as const) {
      if (patch[k] !== undefined) (set as Record<string, unknown>)[k] = patch[k];
    }
    if (Object.keys(set).length > 0) {
      await tx.update(coupons).set(set).where(eq(coupons.id, couponId));
    }
    const [updated] = await tx.select().from(coupons).where(eq(coupons.id, couponId)).limit(1);
    await writeAudit(tx, ctx, 'coupon.updated', 'coupon', couponId, existing as unknown as Record<string, unknown>, set);
    return updated!;
  });
}

export async function deleteCoupon(ctx: AuditCtx, owner: CouponOwner, couponId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const existing = await getOwnedCoupon(owner, couponId);
    if (!existing) throw new NotFound('Coupon not found', 'coupon_not_found');
    await tx.delete(coupons).where(eq(coupons.id, couponId));
    await writeAudit(tx, ctx, 'coupon.deleted', 'coupon', couponId, existing as unknown as Record<string, unknown>, null);
  });
}

/**
 * Resolve a typed code for an item purchase. Looks among the item's tenant's
 * coupons + platform coupons; org-owned wins on an exact-code collision. Then
 * runs the pure validation + the per-user limit check (DB count). Returns the
 * coupon and its funder, or a typed error.
 */
export async function resolveCouponForCheckout(args: {
  code: string;
  tenantId: string;
  userId: string;
  basePaise: number;
  now: Date;
  item: CheckoutItem;
}): Promise<{ ok: true; coupon: Coupon; funder: 'org' | 'platform' } | { ok: false; code: CouponErrorCode }> {
  const code = args.code.trim();
  const rows = await db
    .select()
    .from(coupons)
    .where(
      and(
        eq(coupons.code, code),
        or(
          and(eq(coupons.ownerType, 'tenant'), eq(coupons.tenantId, args.tenantId)),
          and(eq(coupons.ownerType, 'platform'), isNull(coupons.tenantId)),
        ),
      ),
    );
  if (rows.length === 0) return { ok: false, code: 'coupon_not_found' };
  // Org-owned wins on collision.
  const coupon = rows.find((r) => r.ownerType === 'tenant') ?? rows[0]!;

  const base = validateCoupon(coupon, { basePaise: args.basePaise, now: args.now, item: args.item });
  if (!base.ok) return base;

  if (coupon.perUserLimit != null) {
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(couponRedemptions)
      .where(and(eq(couponRedemptions.couponId, coupon.id), eq(couponRedemptions.userId, args.userId)));
    if ((n ?? 0) >= coupon.perUserLimit) return { ok: false, code: 'coupon_user_limit' };
  }

  return { ok: true, coupon, funder: coupon.ownerType === 'platform' ? 'platform' : 'org' };
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/api && pnpm typecheck`
Expected: PASS. (The pure validation test from Task 4 still passes — re-run it: `pnpm vitest run src/services/coupon_service.validate.test.ts`.)

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/coupon_service.ts
git commit -m "feat(api): coupon CRUD + checkout resolution"
```

---

## Task 6: Capabilities

**Files:**
- Modify: `apps/api/src/lib/authz/capabilities.ts`
- Modify: `apps/api/src/lib/authz/role_caps.ts`

- [ ] **Step 1: Add the capabilities**

In `apps/api/src/lib/authz/capabilities.ts`, add to the `Capability` union (after `'memberships.write'`):

```ts
  | 'discounts.read'
  | 'discounts.write'
```

…and to the platform-only block (after `'admin.audit.read'`):

```ts
  | 'admin.coupons.read'
  | 'admin.coupons.write'
```

…and add all four to the `ALL_CAPABILITIES` array (in the matching positions):

```ts
  'discounts.read', 'discounts.write',
```

```ts
  'admin.coupons.read', 'admin.coupons.write',
```

- [ ] **Step 2: Grant them in `role_caps.ts`**

In `PARTNER_CAPS`: add `'discounts.read', 'discounts.write'` to `owner` and `manager`; add `'discounts.read'` to `staff` and `readonly`.

In `PLATFORM_CAPS`: `owner` already spreads `PARTNER_CAPS.owner` (so it gets discounts.*) — additionally add `'admin.coupons.read', 'admin.coupons.write'` to `owner` and `manager`; add `'admin.coupons.read'` to `staff` and `readonly`.

- [ ] **Step 3: Run the authz snapshot tests**

Run: `cd apps/api && pnpm vitest run src/lib/authz`
Expected: PASS. If a snapshot test asserts an exact grant set and fails, update the snapshot to include the new caps (the failure is the intended default-deny review gate).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/lib/authz/capabilities.ts apps/api/src/lib/authz/role_caps.ts
git commit -m "feat(api): discounts + admin.coupons capabilities"
```

---

## Task 7: Coupon routes (org + admin)

**Files:**
- Create: `apps/api/src/routes/coupons.ts`
- Create: `apps/api/src/routes/coupons.test.ts`
- Modify: `apps/api/src/server.ts`

- [ ] **Step 1: Write the routes**

`apps/api/src/routes/coupons.ts`:

```ts
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { BadRequest, Forbidden } from '../lib/errors.js';
import { can } from '../lib/authz/can.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
import { requireTenantMembership } from '../middleware/tenant_context.js';
import { getPlatformTenantId } from '../services/platform_service.js';
import {
  createCoupon,
  deleteCoupon,
  listCoupons,
  updateCoupon,
  type CouponOwner,
} from '../services/coupon_service.js';

const createBody = z.object({
  code: z.string().min(1).max(64),
  description: z.string().max(500).optional(),
  scopeType: z.enum(['org', 'venue', 'event', 'arena', 'membership']),
  scopeId: z.string().uuid().optional(),
  discountType: z.enum(['percent', 'fixed']),
  discountValue: z.number().int().positive(),
  maxDiscountPaise: z.number().int().positive().optional(),
  minOrderPaise: z.number().int().positive().optional(),
  visibility: z.enum(['public', 'private']).optional(),
  validFrom: z.string().datetime().optional(),
  validUntil: z.string().datetime().optional(),
  maxRedemptions: z.number().int().positive().optional(),
  perUserLimit: z.number().int().positive().optional(),
});

const updateBody = z.object({
  description: z.string().max(500).nullable().optional(),
  minOrderPaise: z.number().int().positive().nullable().optional(),
  maxDiscountPaise: z.number().int().positive().nullable().optional(),
  visibility: z.enum(['public', 'private']).optional(),
  validFrom: z.string().datetime().nullable().optional(),
  validUntil: z.string().datetime().nullable().optional(),
  maxRedemptions: z.number().int().positive().nullable().optional(),
  perUserLimit: z.number().int().positive().nullable().optional(),
  status: z.enum(['active', 'paused', 'expired']).optional(),
});

function toCreateInput(b: z.infer<typeof createBody>) {
  return {
    ...b,
    validFrom: b.validFrom ? new Date(b.validFrom) : null,
    validUntil: b.validUntil ? new Date(b.validUntil) : null,
  };
}
function toUpdatePatch(b: z.infer<typeof updateBody>) {
  return {
    ...b,
    validFrom: b.validFrom === undefined ? undefined : b.validFrom ? new Date(b.validFrom) : null,
    validUntil: b.validUntil === undefined ? undefined : b.validUntil ? new Date(b.validUntil) : null,
  };
}

export const couponRoutes: FastifyPluginAsync = async (app) => {
  // ── Org coupons ────────────────────────────────────────────────────────────
  app.get('/v1/tenants/:tenantId/coupons', { preHandler: requireAuth }, async (req) => {
    const { tenantId } = req.params as { tenantId: string };
    const user = await currentUser(req);
    const ctx = await requireTenantMembership(user.id, tenantId);
    if (!can(ctx, 'discounts.read')) throw new Forbidden('Not allowed', 'forbidden');
    return listCoupons({ kind: 'tenant', tenantId });
  });

  app.post('/v1/tenants/:tenantId/coupons', { preHandler: requireAuth }, async (req) => {
    const { tenantId } = req.params as { tenantId: string };
    const user = await currentUser(req);
    const ctx = await requireTenantMembership(user.id, tenantId);
    if (!can(ctx, 'discounts.write')) throw new Forbidden('Not allowed', 'forbidden');
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) throw new BadRequest('Invalid coupon payload', 'bad_request', { issues: parsed.error.issues });
    const owner: CouponOwner = { kind: 'tenant', tenantId };
    return createCoupon({ tenantId, actorUserId: user.id }, owner, toCreateInput(parsed.data));
  });

  app.patch('/v1/tenants/:tenantId/coupons/:id', { preHandler: requireAuth }, async (req) => {
    const { tenantId, id } = req.params as { tenantId: string; id: string };
    const user = await currentUser(req);
    const ctx = await requireTenantMembership(user.id, tenantId);
    if (!can(ctx, 'discounts.write')) throw new Forbidden('Not allowed', 'forbidden');
    const parsed = updateBody.safeParse(req.body);
    if (!parsed.success) throw new BadRequest('Invalid patch', 'bad_request', { issues: parsed.error.issues });
    return updateCoupon({ tenantId, actorUserId: user.id }, { kind: 'tenant', tenantId }, id, toUpdatePatch(parsed.data));
  });

  app.delete('/v1/tenants/:tenantId/coupons/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { tenantId, id } = req.params as { tenantId: string; id: string };
    const user = await currentUser(req);
    const ctx = await requireTenantMembership(user.id, tenantId);
    if (!can(ctx, 'discounts.write')) throw new Forbidden('Not allowed', 'forbidden');
    await deleteCoupon({ tenantId, actorUserId: user.id }, { kind: 'tenant', tenantId }, id);
    return reply.code(204).send();
  });

  // ── Platform (admin) coupons ─────────────────────────────────────────────────
  app.get('/v1/admin/coupons', { preHandler: requireAuth }, async (req) => {
    const user = await currentUser(req);
    const platformTenantId = await getPlatformTenantId();
    const ctx = await requireTenantMembership(user.id, platformTenantId);
    if (!can(ctx, 'admin.coupons.read')) throw new Forbidden('Not allowed', 'forbidden');
    return listCoupons({ kind: 'platform' });
  });

  app.post('/v1/admin/coupons', { preHandler: requireAuth }, async (req) => {
    const user = await currentUser(req);
    const platformTenantId = await getPlatformTenantId();
    const ctx = await requireTenantMembership(user.id, platformTenantId);
    if (!can(ctx, 'admin.coupons.write')) throw new Forbidden('Not allowed', 'forbidden');
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) throw new BadRequest('Invalid coupon payload', 'bad_request', { issues: parsed.error.issues });
    return createCoupon({ tenantId: platformTenantId, actorUserId: user.id }, { kind: 'platform' }, toCreateInput(parsed.data));
  });

  app.patch('/v1/admin/coupons/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const user = await currentUser(req);
    const platformTenantId = await getPlatformTenantId();
    const ctx = await requireTenantMembership(user.id, platformTenantId);
    if (!can(ctx, 'admin.coupons.write')) throw new Forbidden('Not allowed', 'forbidden');
    const parsed = updateBody.safeParse(req.body);
    if (!parsed.success) throw new BadRequest('Invalid patch', 'bad_request', { issues: parsed.error.issues });
    return updateCoupon({ tenantId: platformTenantId, actorUserId: user.id }, { kind: 'platform' }, id, toUpdatePatch(parsed.data));
  });

  app.delete('/v1/admin/coupons/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const user = await currentUser(req);
    const platformTenantId = await getPlatformTenantId();
    const ctx = await requireTenantMembership(user.id, platformTenantId);
    if (!can(ctx, 'admin.coupons.write')) throw new Forbidden('Not allowed', 'forbidden');
    await deleteCoupon({ tenantId: platformTenantId, actorUserId: user.id }, { kind: 'platform' }, id);
    return reply.code(204).send();
  });
};
```

> **Verify before coding:** confirm the exact names/paths of `can` (`../lib/authz/can.js`), `Forbidden` (`../lib/errors.js`), `requireTenantMembership` (`../middleware/tenant_context.js`), and `getPlatformTenantId`. Earlier exploration showed admin routes use `assertCap(ctx, 'cap')` — if that helper is the established pattern, use `assertCap(ctx, 'discounts.write')` instead of the `if (!can(...)) throw Forbidden` form. Grep: `grep -rn "assertCap\|export function can\|getPlatformTenantId" apps/api/src`. Match whichever the codebase already uses; the route logic is otherwise identical.

- [ ] **Step 2: Register in `server.ts`**

In `apps/api/src/server.ts`, import and register alongside the existing route registrations:

```ts
import { couponRoutes } from './routes/coupons.js';
// …
await app.register(couponRoutes);
```

- [ ] **Step 3: Write integration tests**

`apps/api/src/routes/coupons.test.ts` — mirror `events.test.ts`'s harness (the `vi.mock('../lib/firebase_admin.js', …)` token map, `describe.skipIf(!runIntegration)`, tenant bootstrap in `beforeAll`, cleanup in `afterAll`). Cover:

```ts
// (inside the describe block, after creating an owner + tenant)
it('creates an org coupon and lists it', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/tenants/${tenantId}/coupons`,
    headers: bearer('owner'),
    payload: { code: `SUMMER-${SUFFIX}`, scopeType: 'org', discountType: 'percent', discountValue: 1000, visibility: 'public' },
  });
  expect(res.statusCode).toBe(200);
  const list = await app.inject({ method: 'GET', url: `/v1/tenants/${tenantId}/coupons`, headers: bearer('owner') });
  expect((list.json() as unknown[]).length).toBe(1);
});

it('rejects a non-org scope without a scopeId', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/tenants/${tenantId}/coupons`,
    headers: bearer('owner'),
    payload: { code: `V-${SUFFIX}`, scopeType: 'venue', discountType: 'fixed', discountValue: 5000 },
  });
  expect(res.statusCode).toBe(400);
});

it('rejects a duplicate code for the same tenant', async () => {
  const payload = { code: `DUP-${SUFFIX}`, scopeType: 'org' as const, discountType: 'fixed' as const, discountValue: 5000 };
  await app.inject({ method: 'POST', url: `/v1/tenants/${tenantId}/coupons`, headers: bearer('owner'), payload });
  const res = await app.inject({ method: 'POST', url: `/v1/tenants/${tenantId}/coupons`, headers: bearer('owner'), payload });
  expect(res.statusCode).toBe(409);
});
```

Add `coupons` + `coupon_redemptions` cleanup to `afterAll`:

```ts
await db.execute(sql`delete from coupon_redemptions where tenant_id = ${tenantId}`);
await db.execute(sql`delete from coupons where tenant_id = ${tenantId}`);
```

- [ ] **Step 4: Run tests**

Run: `cd apps/api && RUN_INTEGRATION=1 pnpm vitest run src/routes/coupons.test.ts`
Expected: PASS (against a migrated local DB).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/coupons.ts apps/api/src/routes/coupons.test.ts apps/api/src/server.ts
git commit -m "feat(api): coupon CRUD routes (org + admin)"
```

---

## Task 8: Consumer quote + public-coupons endpoints

**Files:**
- Create: `apps/api/src/routes/checkout.ts`
- Create: `apps/api/src/routes/checkout.test.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/src/services/coupon_service.ts` (add `listPublicCouponsForItem` + `priceItem` helper)

- [ ] **Step 1: Add a base-price resolver + public-list to `coupon_service.ts`**

The quote endpoint needs the item's base price and tenant. Add to `coupon_service.ts`:

```ts
import { events } from '../db/schema/events.js';
import { memberships } from '../db/schema/memberships.js';
import { slots } from '../db/schema/slots.js';
import { inArray } from 'drizzle-orm';

export interface PricedItem {
  tenantId: string;
  basePaise: number;
  item: CheckoutItem;
}

/** Resolve base price + tenant + scope-item for a quote/booking request. */
export async function priceItem(req:
  | { itemType: 'event'; eventId: string }
  | { itemType: 'membership'; membershipId: string }
  | { itemType: 'slot'; slotIds: string[] },
): Promise<PricedItem> {
  if (req.itemType === 'event') {
    const [ev] = await db.select().from(events).where(eq(events.id, req.eventId)).limit(1);
    if (!ev) throw new NotFound('Event not found', 'event_not_found');
    return { tenantId: ev.tenantId, basePaise: ev.pricePaise, item: { type: 'event', id: ev.id, venueId: ev.venueId } };
  }
  if (req.itemType === 'membership') {
    const [m] = await db.select().from(memberships).where(eq(memberships.id, req.membershipId)).limit(1);
    if (!m) throw new NotFound('Membership not found', 'membership_not_found');
    return { tenantId: m.tenantId, basePaise: m.pricePaise ?? 0, item: { type: 'membership', id: m.id, venueId: m.venueId } };
  }
  // slots: sum prices, all must share one arena + tenant
  const rows = await db.select().from(slots).where(inArray(slots.id, req.slotIds));
  if (rows.length === 0 || rows.length !== req.slotIds.length) throw new NotFound('Slot not found', 'slot_not_found');
  const arenaId = rows[0]!.arenaId;
  const tenantId = rows[0]!.tenantId;
  if (!rows.every((r) => r.arenaId === arenaId && r.tenantId === tenantId)) {
    throw new BadRequest('Slots must share one arena', 'multi_arena_booking');
  }
  const basePaise = rows.reduce((s, r) => s + r.pricePaise, 0);
  // venueId for an arena-scoped coupon match comes from the arena → venue; we
  // carry it as null here since slot/arena coupons match on arena id, and venue
  // coupons on slots are matched via the arena's venue in the booking path.
  return { tenantId, basePaise, item: { type: 'slot', id: arenaId, venueId: null } };
}

/** Public, in-window coupons applicable to an item (for the offers picker). */
export async function listPublicCouponsForItem(priced: PricedItem, now: Date): Promise<Coupon[]> {
  const rows = await db
    .select()
    .from(coupons)
    .where(
      and(
        eq(coupons.visibility, 'public'),
        eq(coupons.status, 'active'),
        or(
          and(eq(coupons.ownerType, 'tenant'), eq(coupons.tenantId, priced.tenantId)),
          and(eq(coupons.ownerType, 'platform'), isNull(coupons.tenantId)),
        ),
      ),
    );
  return rows.filter((c) => validateCoupon(c, { basePaise: priced.basePaise, now, item: priced.item }).ok);
}
```

> **Note on slot venue matching:** for a venue-scoped coupon on a slot booking, `priceItem` returns `venueId: null`, so `couponMatchesItem` would reject it. If venue-scoped coupons must apply to slot bookings, look up the arena's `venueId` in `priceItem` (one extra select on `arenas`) and set it. Decide during implementation; the spec allows venue-scoped coupons, so prefer resolving the arena's venue here.

- [ ] **Step 2: Write the routes**

`apps/api/src/routes/checkout.ts`:

```ts
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { BadRequest } from '../lib/errors.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
import { computeCheckout } from '../services/checkout_pricing.js';
import {
  listPublicCouponsForItem,
  priceItem,
  resolveCouponForCheckout,
} from '../services/coupon_service.js';

const itemSchema = z.union([
  z.object({ itemType: z.literal('event'), eventId: z.string().uuid() }),
  z.object({ itemType: z.literal('membership'), membershipId: z.string().uuid() }),
  z.object({ itemType: z.literal('slot'), slotIds: z.array(z.string().uuid()).min(1) }),
]);
const quoteBody = z.intersection(itemSchema, z.object({ couponCode: z.string().min(1).max(64).optional() }));

export const checkoutRoutes: FastifyPluginAsync = async (app) => {
  app.post('/v1/consumer/checkout/quote', { preHandler: requireAuth }, async (req) => {
    const parsed = quoteBody.safeParse(req.body);
    if (!parsed.success) throw new BadRequest('Invalid quote payload', 'bad_request', { issues: parsed.error.issues });
    const user = await currentUser(req);
    const now = new Date();
    const priced = await priceItem(parsed.data);

    if (!parsed.data.couponCode) {
      const b = computeCheckout(priced.basePaise, null);
      return { ...b, coupon: null };
    }
    const resolved = await resolveCouponForCheckout({
      code: parsed.data.couponCode,
      tenantId: priced.tenantId,
      userId: user.id,
      basePaise: priced.basePaise,
      now,
      item: priced.item,
    });
    if (!resolved.ok) {
      // Coupon not applied — return base pricing + the error code so the UI can explain.
      const b = computeCheckout(priced.basePaise, null);
      return { ...b, coupon: null, error: resolved.code };
    }
    const b = computeCheckout(priced.basePaise, {
      discountType: resolved.coupon.discountType,
      discountValue: resolved.coupon.discountValue,
      maxDiscountPaise: resolved.coupon.maxDiscountPaise,
    });
    return {
      ...b,
      coupon: { id: resolved.coupon.id, code: resolved.coupon.code, description: resolved.coupon.description },
    };
  });

  app.get('/v1/consumer/coupons', async (req) => {
    const q = z
      .union([
        z.object({ itemType: z.literal('event'), itemId: z.string().uuid() }),
        z.object({ itemType: z.literal('membership'), itemId: z.string().uuid() }),
      ])
      .safeParse(req.query);
    if (!q.success) throw new BadRequest('Invalid query', 'bad_request', { issues: q.error.issues });
    const priced =
      q.data.itemType === 'event'
        ? await priceItem({ itemType: 'event', eventId: q.data.itemId })
        : await priceItem({ itemType: 'membership', membershipId: q.data.itemId });
    const rows = await listPublicCouponsForItem(priced, new Date());
    return {
      rows: rows.map((c) => ({
        code: c.code,
        description: c.description,
        discountType: c.discountType,
        discountValue: c.discountValue,
        maxDiscountPaise: c.maxDiscountPaise,
        minOrderPaise: c.minOrderPaise,
      })),
    };
  });
};
```

- [ ] **Step 3: Register in `server.ts`**

```ts
import { checkoutRoutes } from './routes/checkout.js';
// …
await app.register(checkoutRoutes);
```

- [ ] **Step 4: Integration tests**

`apps/api/src/routes/checkout.test.ts` — mirror the harness; create a tenant, a published event at `pricePaise: 50000`, and a public org coupon; assert:

```ts
it('quotes base pricing with no coupon', async () => {
  const res = await app.inject({ method: 'POST', url: '/v1/consumer/checkout/quote', headers: bearer('owner'), payload: { itemType: 'event', eventId } });
  expect(res.statusCode).toBe(200);
  const q = res.json();
  expect(q.basePaise).toBe(50000);
  expect(q.totalPaise).toBe(51209);
  expect(q.discountPaise).toBe(0);
});

it('applies a valid coupon in the quote', async () => {
  const res = await app.inject({ method: 'POST', url: '/v1/consumer/checkout/quote', headers: bearer('owner'), payload: { itemType: 'event', eventId, couponCode } });
  const q = res.json();
  expect(q.discountPaise).toBe(5000);
  expect(q.totalPaise).toBe(46088);
  expect(q.coupon.code).toBe(couponCode);
});

it('returns base pricing + error for an unknown coupon', async () => {
  const res = await app.inject({ method: 'POST', url: '/v1/consumer/checkout/quote', headers: bearer('owner'), payload: { itemType: 'event', eventId, couponCode: 'NOPE' } });
  const q = res.json();
  expect(q.error).toBe('coupon_not_found');
  expect(q.totalPaise).toBe(51209);
});
```

(Booking the event requires a published event — set status directly via `db.execute(sql\`update events set status='published' where id=${eventId}\`)` in setup, matching how other tests stage published listings.)

- [ ] **Step 5: Run tests**

Run: `cd apps/api && RUN_INTEGRATION=1 pnpm vitest run src/routes/checkout.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/checkout.ts apps/api/src/routes/checkout.test.ts apps/api/src/services/coupon_service.ts apps/api/src/server.ts
git commit -m "feat(api): consumer checkout quote + public coupons endpoints"
```

---

## Task 9: createRouteOrder records settle base

**Files:**
- Modify: `apps/api/src/services/payments_service.ts`

- [ ] **Step 1: Extend `CreateRouteOrderInput` + the insert**

In `apps/api/src/services/payments_service.ts`, add to `CreateRouteOrderInput`:

```ts
  /** Org-settleable base for this charge (gross-up excluded; full base when
   *  platform-funded). Defaults to amountPaise when omitted (legacy callers). */
  settleBasePaise?: number;
```

In `createRouteOrder`, set it on the insert values:

```ts
      amountPaise: input.amountPaise,
      settleBasePaise: input.settleBasePaise ?? input.amountPaise,
      currency: 'INR',
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/api && pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/payments_service.ts
git commit -m "feat(api): createRouteOrder persists settle_base_paise"
```

---

## Task 10: Booking integration (slots, events, memberships)

This threads `couponCode` from the consumer routes through to the booking services, which: resolve+validate the coupon, compute the grossed-up total, set `settleBasePaise`, store `base/discount/coupon` on the booking, and record a redemption with an atomic `redeemed_count` bump (so a total-cap race rolls the booking back).

**Files:**
- Modify: `apps/api/src/routes/consumer.ts`
- Modify: `apps/api/src/services/consumer_service.ts`
- Modify: `apps/api/src/services/booking_service.ts`
- Modify: `apps/api/src/services/memberships_service.ts`
- Test: `apps/api/src/routes/checkout.test.ts` (extend with booking assertions) or a new `apps/api/src/services/coupon_redemption.test.ts`

- [ ] **Step 1: Add a shared redemption recorder to `coupon_service.ts`**

Append to `coupon_service.ts`:

```ts
import type { PgTransaction } from 'drizzle-orm/pg-core';

/**
 * Atomically bump redeemed_count (respecting max_redemptions) and insert the
 * redemption row, inside the caller's booking transaction. Throws a Conflict
 * if the total cap is now exhausted (a lost race) so the booking rolls back.
 */
export async function recordRedemption(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  args: {
    coupon: Coupon;
    bookingId: string;
    userId: string;
    tenantId: string;
    basePaise: number;
    discountPaise: number;
    funder: 'org' | 'platform';
  },
): Promise<void> {
  // Conditional bump: only succeeds while under the cap (or uncapped).
  const bumped = await tx
    .update(coupons)
    .set({ redeemedCount: sql`${coupons.redeemedCount} + 1` })
    .where(
      and(
        eq(coupons.id, args.coupon.id),
        args.coupon.maxRedemptions != null
          ? sql`${coupons.redeemedCount} < ${args.coupon.maxRedemptions}`
          : sql`true`,
      ),
    )
    .returning({ id: coupons.id });
  if (bumped.length === 0) throw new Conflict('Coupon fully redeemed', 'coupon_max_redeemed');

  await tx.insert(couponRedemptions).values({
    couponId: args.coupon.id,
    bookingId: args.bookingId,
    userId: args.userId,
    tenantId: args.tenantId,
    basePaise: args.basePaise,
    discountPaise: args.discountPaise,
    funder: args.funder,
  });
}
```

(The `PgTransaction` import is only for reference; use the `tx` type inferred from `db.transaction`'s callback as shown.)

- [ ] **Step 2: Apply coupon in `bookEvent`**

In `booking_service.ts` `bookEvent`, change the signature to accept an optional resolved coupon and base, and apply the gross-up. Specifically:

- Add to `BookEventCustomer` (or a new param) the resolved coupon. Simpler: add a parameter `pricing?: { coupon: Coupon; funder: 'org'|'platform' } | null`.
- Inside the transaction, after loading `ev`, compute:

```ts
const basePaise = ev.pricePaise;
const breakdown = computeCheckout(
  basePaise,
  pricing ? { discountType: pricing.coupon.discountType, discountValue: pricing.coupon.discountValue, maxDiscountPaise: pricing.coupon.maxDiscountPaise } : null,
);
const isFree = breakdown.totalPaise === 0;
const settleBasePaise = pricing && pricing.funder === 'platform' ? basePaise : breakdown.discountedBasePaise;
```

- Insert the booking with `pricePaise: basePaise`, `basePaise`, `discountPaise: breakdown.discountPaise`, `totalPaise: breakdown.totalPaise`, `couponId: pricing?.coupon.id ?? null`, `paymentMethod: isFree ? 'free' : 'razorpay_route'`, `status: isFree ? 'confirmed' : 'pending'`.
- After the booking insert (still in tx), if `pricing` record the redemption:

```ts
if (pricing) {
  await recordRedemption(tx, {
    coupon: pricing.coupon, bookingId: b.id, userId: customer.userId,
    tenantId: ev.tenantId, basePaise, discountPaise: breakdown.discountPaise, funder: pricing.funder,
  });
}
```

- In the paid path, pass the new total + settle base to `createRouteOrder`:

```ts
const result = await paymentsService.createRouteOrder({
  bookingId: reserved.booking.id,
  tenantId: reserved.tenantId,
  amountPaise: reserved.breakdown.totalPaise,
  settleBasePaise: reserved.settleBasePaise,
  actorUserId: customer.userId,
});
// and return amountPaise: reserved.breakdown.totalPaise
```

(Return `breakdown` + `settleBasePaise` from the transaction alongside `booking`.)

Add the import at the top of `booking_service.ts`:

```ts
import { computeCheckout } from './checkout_pricing.js';
import { recordRedemption } from './coupon_service.js';
import type { Coupon } from '../db/schema/coupons.js';
```

- [ ] **Step 3: Apply the same pattern in `prepareOnlineBookingWithPayment` (slots) and `purchaseMembership`**

**Slots** — `prepareOnlineBookingWithPayment` in `booking_service.ts`. Add a `pricing?: { coupon: Coupon; funder: 'org'|'platform' } | null` parameter. Inside the transaction, the base is `total` (the existing `sel.reduce(...)` sum of slot prices). Replace the booking insert + return with the coupon-aware version:

```ts
const basePaise = total; // existing sum of slot prices
const breakdown = computeCheckout(
  basePaise,
  pricing ? { discountType: pricing.coupon.discountType, discountValue: pricing.coupon.discountValue, maxDiscountPaise: pricing.coupon.maxDiscountPaise } : null,
);
const isFree = breakdown.totalPaise === 0;
const settleBasePaise = pricing && pricing.funder === 'platform' ? basePaise : breakdown.discountedBasePaise;

const [booking] = await tx
  .insert(bookings)
  .values({
    tenantId: ctx.tenantId,
    venueId,
    itemType: 'slot',
    channel: 'circls',
    paymentMethod: isFree ? 'free' : 'razorpay_route',
    status: isFree ? 'confirmed' : 'pending',
    customerName: input.customerName,
    customerContact: input.customerContact,
    note: input.note ?? null,
    basePaise,
    discountPaise: breakdown.discountPaise,
    couponId: pricing?.coupon.id ?? null,
    totalPaise: breakdown.totalPaise,
    createdByUserId: ctx.actorUserId,
  })
  .returning();
// …existing atomic slot-claim + arena/timeRange update stay unchanged…

if (pricing) {
  await recordRedemption(tx, {
    coupon: pricing.coupon, bookingId: booking!.id, userId: ctx.actorUserId,
    tenantId: ctx.tenantId, basePaise, discountPaise: breakdown.discountPaise, funder: pricing.funder,
  });
}

return { bookingId: booking!.id, totalPaise: breakdown.totalPaise, settleBasePaise, isFree };
```

Then after the transaction, skip Razorpay for the free case and otherwise pass the grossed-up total + settle base:

```ts
if (isFree) {
  return { bookingId, payment: { orderId: '', keyId: '', amountPaise: 0, currency: 'INR' } };
}
const { providerOrderId } = await createRouteOrder({
  bookingId, tenantId: ctx.tenantId, amountPaise: totalPaise, settleBasePaise, actorUserId: ctx.actorUserId,
});
return { bookingId, payment: { orderId: providerOrderId, keyId: env.RAZORPAY_KEY_ID ?? '', amountPaise: totalPaise, currency: 'INR' } };
```

**Memberships** — `purchaseMembership` in `memberships_service.ts`. Add the same `pricing` parameter. The base is the membership `pricePaise`. Inside the reservation transaction, compute the breakdown and settle base exactly as in `bookEvent` (Task 10 Step 2):

```ts
const basePaise = m.pricePaise ?? 0;
const breakdown = computeCheckout(
  basePaise,
  pricing ? { discountType: pricing.coupon.discountType, discountValue: pricing.coupon.discountValue, maxDiscountPaise: pricing.coupon.maxDiscountPaise } : null,
);
const isFree = breakdown.totalPaise === 0;
const settleBasePaise = pricing && pricing.funder === 'platform' ? basePaise : breakdown.discountedBasePaise;
```

Insert the booking with `pricePaise: basePaise, basePaise, discountPaise: breakdown.discountPaise, couponId: pricing?.coupon.id ?? null, totalPaise: breakdown.totalPaise, paymentMethod: isFree ? 'free' : 'razorpay_route', status: isFree ? 'confirmed' : 'pending'`; record the redemption in-tx when `pricing` is set (same `recordRedemption` call as above with `userId: customer.userId`); and in the paid path call `createRouteOrder({ …, amountPaise: breakdown.totalPaise, settleBasePaise })`, returning `amountPaise: breakdown.totalPaise`. Keep the existing `userMemberships` entitlement insert unchanged. Add the same imports (`computeCheckout`, `recordRedemption`, `Coupon`) to `memberships_service.ts`.

- [ ] **Step 4: Resolve the coupon in `consumer_service.ts` and pass it down**

In `consumer_service.ts`, `consumerBookEvent` / `consumerBookSlots` / `consumerPurchaseMembership` gain an optional `couponCode`. Each:

```ts
let pricing: { coupon: Coupon; funder: 'org' | 'platform' } | null = null;
if (couponCode) {
  const priced = await priceItem(/* the item refs */);
  const resolved = await resolveCouponForCheckout({
    code: couponCode, tenantId: priced.tenantId, userId, basePaise: priced.basePaise, now: new Date(), item: priced.item,
  });
  if (!resolved.ok) throw new BadRequest('Coupon not applicable', resolved.code);
  pricing = { coupon: resolved.coupon, funder: resolved.funder };
}
// pass `pricing` into bookEvent/prepareOnlineBookingWithPayment/purchaseMembership
```

Map `resolved.code` to a 400 (or 409 for `coupon_max_redeemed`) — reuse `BadRequest`/`Conflict` with the code as the error code so the client gets a typed reason.

- [ ] **Step 5: Accept `couponCode` in the consumer route bodies**

In `apps/api/src/routes/consumer.ts`, add `couponCode: z.string().min(1).max(64).optional()` to `bookSlotsBody`, `bookEventBody`, and the membership purchase body, and forward it to the service calls.

- [ ] **Step 6: Write the redemption integration test**

Extend `checkout.test.ts` (or new `coupon_redemption.test.ts`):

```ts
it('books an event with a platform coupon: redemption recorded, settle base = full base', async () => {
  // setup: published event pricePaise 50000; platform coupon 'PLAT10' 10% (created via /v1/admin/coupons by a platform owner, or seeded directly)
  const res = await app.inject({ method: 'POST', url: `/v1/consumer/events/${eventId}/book`, headers: bearer('owner'), payload: { couponCode: 'PLAT10' } });
  expect(res.statusCode).toBe(200);
  const bookingId = (res.json() as { booking: { id: string } }).booking.id;
  const red = await db.execute(sql`select discount_paise, funder, base_paise from coupon_redemptions where booking_id = ${bookingId}`);
  expect(Number((red as any)[0].discount_paise)).toBe(5000);
  expect((red as any)[0].funder).toBe('platform');
  const pay = await db.execute(sql`select settle_base_paise, amount_paise from payments where booking_id = ${bookingId}`);
  expect(Number((pay as any)[0].settle_base_paise)).toBe(50000); // full base — org made whole
  expect(Number((pay as any)[0].amount_paise)).toBe(46088);      // grossed-up discounted total
});

it('enforces total max redemptions', async () => {
  // coupon with maxRedemptions: 1, already redeemed once → second booking 409 coupon_max_redeemed
});
```

- [ ] **Step 7: Run tests**

Run: `cd apps/api && RUN_INTEGRATION=1 pnpm vitest run src/routes/checkout.test.ts src/services`
Expected: PASS. Then full suite: `cd apps/api && pnpm vitest run` (pure tests) and `RUN_INTEGRATION=1 pnpm vitest run` locally.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/routes/consumer.ts apps/api/src/services/consumer_service.ts apps/api/src/services/booking_service.ts apps/api/src/services/memberships_service.ts apps/api/src/services/coupon_service.ts apps/api/src/routes/checkout.test.ts
git commit -m "feat(api): apply coupons + gross-up in slot/event/membership booking"
```

---

## Task 11: Payout uses settle base

**Files:**
- Modify: `apps/api/src/services/payout_service.ts`
- Test: `apps/api/src/services/payout_service.test.ts`

- [ ] **Step 1: Write/extend the failing test**

In `payout_service.test.ts`, add a case asserting that gross is summed from `settle_base_paise`, not `amount_paise` (a captured charge with `amount_paise=46088, settle_base_paise=50000` contributes 50000 to gross). Follow the existing test's seeding pattern for payments + tenant.

- [ ] **Step 2: Change the gross query**

In `reconcileWeeklyPayouts`, change the gross sum to prefer `settle_base_paise` with an `amount_paise` fallback for legacy rows:

```ts
      gross: sql<number>`coalesce(sum(coalesce(${payments.settleBasePaise}, ${payments.amountPaise})), 0)::bigint`,
```

- [ ] **Step 3: Run tests**

Run: `cd apps/api && RUN_INTEGRATION=1 pnpm vitest run src/services/payout_service.test.ts`
Expected: PASS (new + existing cases; existing rows have `settle_base_paise = amount_paise` via the fallback, so prior assertions hold).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/payout_service.ts apps/api/src/services/payout_service.test.ts
git commit -m "feat(api): payout gross sums settle_base_paise"
```

---

## Task 12: Full verification

- [ ] **Step 1: Typecheck the whole api package**

Run: `cd apps/api && pnpm typecheck`
Expected: PASS.

- [ ] **Step 2: Run the pure test suite**

Run: `cd apps/api && pnpm vitest run`
Expected: PASS (pure tests; integration tests skip without `RUN_INTEGRATION`).

- [ ] **Step 3: Run the integration suite against a migrated local DB**

Run: `cd apps/api && RUN_INTEGRATION=1 pnpm vitest run`
Expected: PASS.

- [ ] **Step 4: Emit OpenAPI (if the repo tracks it)**

Run: `cd apps/api && pnpm openapi:emit`
Expected: regenerates the spec including the new routes; commit the regenerated artifact if the repo tracks it.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "chore(api): coupons backend — verification + openapi"
```

---

## Self-Review notes (for the implementer)

- **Spec coverage:** money model → Task 1; data model → Tasks 2–3; CRUD + caps → Tasks 5–7; quote + public list → Task 8; settle base → Task 9; booking integration + redemption limits → Task 10; payout → Task 11. Help Centre article is **not** here — it ships with the Partners UI (Plan 2), per repo CLAUDE.md, in the same PR as the partner-facing coupon management.
- **Open implementation decisions flagged inline:** (a) `can` vs `assertCap` helper — match the codebase (Task 7 note); (b) venue-scoped coupons on slot bookings need the arena→venue lookup in `priceItem` (Task 8 note). Resolve both by grepping the existing code before writing.
- **Concurrency:** the redeemed_count bump is a conditional UPDATE inside the booking tx; a lost race throws `coupon_max_redeemed` and rolls back. Per-user limit is best-effort (checked then inserted); acceptable since the unique `(coupon_id, booking_id)` index prevents double-recording a single booking.
