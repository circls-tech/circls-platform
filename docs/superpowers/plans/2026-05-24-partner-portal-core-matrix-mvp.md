# Partner Portal Core Matrix MVP — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a materialized-slot model + redesigned Partner Portal so a venue can build a priced weekly schedule, release dated slots, and take multi-slot walk-in bookings — all concurrency-safe.

**Architecture:** New `slots` table (one row per dated slot, own price + status) materialized from the `weekly_schedule` template over a release window; default prices seeded from `pricing_rules`. Bookings link to slots (`slots.booking_id`), created with one atomic conditional `UPDATE` (multi-slot, no double-book). Soft-delete + `audit_log` on every money/booking mutation. Frontend: Next.js 15 left-sidebar shell, a reusable `<Matrix>` (grid + right inspector) powering both the schedule builder and the reception desk.

**Tech Stack:** Fastify 5 + Drizzle (postgres-js) + Postgres 18; vitest integration tests vs local PG18 (`docker compose`); Next.js 15 + React 19 + Tailwind v4 + TanStack Query + Firebase web SDK.

**Spec:** `docs/superpowers/specs/2026-05-24-partner-portal-redesign-design.md`

**Conventions (already established this session — follow exactly):**
- ESM `.js` import suffixes; strict TS (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).
- Migrations: edit schema → `pnpm --filter @circls/api exec drizzle-kit generate --name=<n>` → hand-add any `EXCLUDE`/extension SQL (see `apps/api/src/db/migrations/0003_*.sql` for the pattern).
- DB error unwrap helpers in `apps/api/src/db/errors.ts` (`isUniqueViolation`, `isExclusionViolation` — walk `.cause`).
- Tenancy: every route resolves `currentUser(req)` then `requireTenantMembership(user.id, tenantId)` (see `apps/api/src/routes/venues.ts`).
- Tests gate on `RUN_INTEGRATION=1`, mock `../lib/firebase_admin.js`, use `app.inject` (see `apps/api/src/routes/bookings.test.ts`).
- Run tests: `export DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5433/circls && docker compose up -d --wait && RUN_INTEGRATION=1 pnpm --filter @circls/api test`.

---

## File Structure

**Backend (`apps/api/src`):**
- Create `db/schema/slots.ts` — `slots`, `slotReleases`, `slotStatus` enum.
- Create `db/schema/audit_log.ts` — `auditLog`.
- Modify `db/schema/bookings.ts` — add customer/total columns; `bookings` stays, slots link via FK.
- Modify `db/schema/index.ts` — export new tables.
- Create `db/migrations/0006_slots.sql` (generated + hand-added EXCLUDE), `0007_bookings_audit.sql`.
- Create `lib/audit.ts` — `writeAudit(tx, ctx, action, entity, before, after)`.
- Create `services/slot_service.ts` — `releaseSlots`, `listSlots`, `bulkUpdateSlots`, `holdSlots`, `releaseHold`.
- Create `services/booking_service.ts` — `createSlotBooking` (multi-slot atomic), `cancelBooking`. *(Replaces walk-in path in `inventory_service.ts`; keep that file for the legacy endpoint or delete its route — see Task 9.)*
- Create `routes/slots.ts`, modify `routes/bookings.ts`, modify `server.ts` (register).
- Tests: `db/slots_exclusion.test.ts`, `services/slot_service.test.ts`, `routes/slots.test.ts`, `routes/bookings_slots.test.ts`.

**Frontend (`apps/partners`):**
- Create `lib/ui/` primitives: `Button.tsx`, `Card.tsx`, `Input.tsx`, `Modal.tsx`, `Badge.tsx`.
- Modify `app/globals.css` — design tokens.
- Create `app/(protected)/layout.tsx` rewrite — sidebar shell + `OrgSwitcher`.
- Create `components/Matrix.tsx` — reusable grid + inspector.
- Create pages: `app/(auth)/signup` (org create), `app/(protected)/onboarding/*`, `app/(protected)/arenas/[arenaId]/schedule/page.tsx` (builder), rewrite `app/(protected)/arenas/[arenaId]/page.tsx` (reception), `components/AddBookingModal.tsx`, `components/ConfirmDialog.tsx`.
- Extend `lib/api/queries.ts` + `lib/api/types.ts`.

---

## PHASE 1 — Backend: slots, releases, audit, bookings

### Task 1: Slots + slot_releases schema and migration

**Files:**
- Create: `apps/api/src/db/schema/slots.ts`
- Modify: `apps/api/src/db/schema/index.ts`
- Create: `apps/api/src/db/migrations/0006_slots.sql` (via generate + hand edit)
- Test: `apps/api/src/db/slots_exclusion.test.ts`

- [ ] **Step 1: Write `slots.ts`**

```ts
import { bigint, customType, pgEnum, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { tstzrange } from './bookings.js';
import { arenas } from './arenas.js';
import { tenants } from './tenants.js';
import { createdAt, updatedAt, uuidPk } from './_columns.js';

export const slotStatus = pgEnum('slot_status', ['open', 'held', 'blocked', 'booked']);

export const slotReleases = pgTable('slot_releases', {
  id: uuidPk(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  arenaId: uuid('arena_id').notNull().references(() => arenas.id),
  startDate: timestamp('start_date', { withTimezone: true }).notNull(),
  endDate: timestamp('end_date', { withTimezone: true }).notNull(),
  quantizationMin: bigint('quantization_min', { mode: 'number' }).notNull(),
  createdAt: createdAt(),
});

export const slots = pgTable('slots', {
  id: uuidPk(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  arenaId: uuid('arena_id').notNull().references(() => arenas.id),
  timeRange: tstzrange('time_range').notNull(),
  pricePaise: bigint('price_paise', { mode: 'number' }).notNull(),
  status: slotStatus('status').notNull().default('open'),
  holdExpiresAt: timestamp('hold_expires_at', { withTimezone: true }),
  bookingId: uuid('booking_id'),
  releaseId: uuid('release_id').references(() => slotReleases.id),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type Slot = typeof slots.$inferSelect;
export type NewSlot = typeof slots.$inferInsert;
```

> Note: `bookingId` is a plain uuid (no FK in the Drizzle object) to avoid a circular FK with `bookings`; the FK is added in the `0007` migration SQL by hand.

- [ ] **Step 2: Export from `index.ts`** — append `export * from './slots.js';`

- [ ] **Step 3: Generate the migration**

Run: `cd apps/api && pnpm exec drizzle-kit generate --name=slots`
Expected: creates `src/db/migrations/0006_slots.sql` with the enum + both tables.

- [ ] **Step 4: Hand-add the exclusion constraint** to the end of `0006_slots.sql`:

```sql
--> statement-breakpoint
ALTER TABLE "slots" ADD CONSTRAINT "slots_no_overlap" EXCLUDE USING gist ("arena_id" WITH =, "time_range" WITH &&) WHERE (deleted_at IS NULL);
```

- [ ] **Step 5: Write the failing test** `slots_exclusion.test.ts` (mirror `bookings_exclusion.test.ts`): insert tenant→arena (via existing tables; venue needed for arena), then insert two overlapping `slots` rows via `db.execute(sql\`insert into slots (...) values (..., tstzrange($s,$e,'[)'), 5000, 'open')\`)`; assert the second throws `isExclusionViolation`. Add a soft-deleted overlap allowed case (`deleted_at = now()` on the first → second insert succeeds).

- [ ] **Step 6: Run migrate + test**

Run: `pnpm --filter @circls/api db:migrate && RUN_INTEGRATION=1 pnpm --filter @circls/api test src/db/slots_exclusion.test.ts`
Expected: PASS (overlap rejected; soft-deleted overlap allowed).

- [ ] **Step 7: Commit** — `git commit -m "phase-A1: slots + slot_releases schema + exclusion constraint"`

### Task 2: audit_log + bookings extension

**Files:** Create `apps/api/src/db/schema/audit_log.ts`; Modify `apps/api/src/db/schema/bookings.ts`, `index.ts`; Create migration `0007_bookings_audit.sql`.

- [ ] **Step 1: `audit_log.ts`**

```ts
import { jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, uuidPk } from './_columns.js';

export const auditLog = pgTable('audit_log', {
  id: uuidPk(),
  tenantId: uuid('tenant_id'),
  actorUserId: uuid('actor_user_id'),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: uuid('entity_id'),
  before: jsonb('before').$type<Record<string, unknown>>(),
  after: jsonb('after').$type<Record<string, unknown>>(),
  createdAt: createdAt(),
});
export type AuditRow = typeof auditLog.$inferSelect;
```

- [ ] **Step 2: Extend `bookings.ts`** — add columns to the `bookings` table object:

```ts
  customerName: text('customer_name'),
  customerContact: text('customer_contact'),
  note: text('note'),
  totalPaise: bigintPaise('total_paise'),
```
(import `bigintPaise` already present.)

- [ ] **Step 3: Export audit_log** from `index.ts`.

- [ ] **Step 4: Generate** `pnpm exec drizzle-kit generate --name=bookings_audit`.

- [ ] **Step 5: Hand-add** the slots→bookings FK to `0007_*.sql`:
```sql
--> statement-breakpoint
ALTER TABLE "slots" ADD CONSTRAINT "slots_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;
```

- [ ] **Step 6: Migrate + typecheck** — `pnpm --filter @circls/api db:migrate && pnpm --filter @circls/api typecheck`. Expected: clean.

- [ ] **Step 7: Commit** — `"phase-A2: audit_log + bookings customer/total columns + slot FK"`

### Task 3: Audit helper

**Files:** Create `apps/api/src/lib/audit.ts`. Test: covered via service tests.

- [ ] **Step 1: Write `audit.ts`**

```ts
import type { PgTransaction } from 'drizzle-orm/pg-core';
import { db } from '../db/client.js';
import { auditLog } from '../db/schema/index.js';

export interface AuditCtx { tenantId: string; actorUserId: string; }

export async function writeAudit(
  exec: typeof db,
  ctx: AuditCtx,
  action: string,
  entityType: string,
  entityId: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): Promise<void> {
  await exec.insert(auditLog).values({
    tenantId: ctx.tenantId,
    actorUserId: ctx.actorUserId,
    action,
    entityType,
    entityId,
    before: before ?? null,
    after: after ?? null,
  });
}
```
> `exec` is `db` or a tx (both satisfy the insert interface); pass the tx inside transactions.

- [ ] **Step 2: typecheck + commit** — `"phase-A3: audit write helper"`

### Task 4: slot_service — release, list, bulk update, holds

**Files:** Create `apps/api/src/services/slot_service.ts`; Test: `apps/api/src/services/slot_service.test.ts`.

- [ ] **Step 1: Write `slot_service.ts`** with these exported functions and signatures:

```ts
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { isExclusionViolation } from '../db/errors.js';
import { type Slot, slotReleases, slots } from '../db/schema/index.js';
import { Conflict } from '../lib/errors.js';
import { writeAudit, type AuditCtx } from '../lib/audit.js';
import { resolvePricePaise } from './pricing_service.js';
import { getArenaById } from './arena_service.js';
import { getVenueById } from './venue_service.js';

export interface ReleaseCell { dayOfWeek: number; startTimeMin: number; durationMin: number; price?: number | null; blocked?: boolean; }
export interface ReleaseInput { startDate: string; endDate: string; quantizationMin: number; cells: ReleaseCell[]; }

/** Materialize slots across [startDate, endDate] from the cell template. Default
 *  price from pricing_rules unless cell.price given. Skips overlaps. Returns count. */
export async function releaseSlots(ctx: AuditCtx, arenaId: string, input: ReleaseInput): Promise<{ created: number; skipped: number }> {
  const arena = await getArenaById(arenaId);
  if (!arena) throw new Conflict('Arena not found', 'arena_not_found');
  const venue = await getVenueById(arena.venueId);
  const tz = venue?.tzName ?? 'Asia/Kolkata';
  return db.transaction(async (tx) => {
    const [rel] = await tx.insert(slotReleases).values({
      tenantId: ctx.tenantId, arenaId, startDate: new Date(input.startDate),
      endDate: new Date(input.endDate), quantizationMin: input.quantizationMin,
    }).returning();
    let created = 0, skipped = 0;
    for (const occ of enumerateOccurrences(input.startDate, input.endDate, input.cells, tz)) {
      const price = occ.price ?? (await resolvePricePaise({ arenaId, startAt: occ.startIso, channel: 'walkin' })) ?? 0;
      try {
        await tx.insert(slots).values({
          tenantId: ctx.tenantId, arenaId,
          timeRange: sql`tstzrange(${occ.startIso}::timestamptz, ${occ.endIso}::timestamptz, '[)')`,
          pricePaise: price, status: occ.blocked ? 'blocked' : 'open', releaseId: rel!.id,
        });
        created++;
      } catch (err) { if (isExclusionViolation(err)) { skipped++; } else { throw err; } }
    }
    return { created, skipped };
  });
}
```
Plus a pure helper `enumerateOccurrences(startIso, endIso, cells, tz)` that, for each date in the window, for each cell whose `dayOfWeek` matches that date's weekday **in tz**, yields `{ startIso, endIso, price, blocked }` (start = date at `startTimeMin` local→UTC; end = start + durationMin). Implement weekday/local-time conversion with `Intl.DateTimeFormat` (mirror `localDayAndMinutes` in `pricing_service.ts`). Export it for unit testing.

```ts
export async function listSlots(arenaId: string, fromIso: string, toIso: string): Promise<Slot[]> {
  return db.select().from(slots).where(and(
    eq(slots.arenaId, arenaId),
    sql`${slots.deletedAt} is null`,
    sql`${slots.timeRange} && tstzrange(${fromIso}::timestamptz, ${toIso}::timestamptz, '[)')`,
  ));
}

export async function bulkUpdateSlots(ctx: AuditCtx, slotIds: string[], patch: { price?: number; blocked?: boolean }): Promise<Slot[]> {
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(slots).where(sql`${slots.id} = any(${slotIds}) and ${slots.deletedAt} is null`);
    for (const r of rows) {
      if (r.status === 'booked' || r.status === 'held') throw new Conflict('Slot is locked', 'slot_locked');
    }
    const set: Partial<typeof slots.$inferInsert> = {};
    if (patch.price !== undefined) set.pricePaise = patch.price;
    if (patch.blocked !== undefined) set.status = patch.blocked ? 'blocked' : 'open';
    const updated = await tx.update(slots).set(set).where(sql`${slots.id} = any(${slotIds})`).returning();
    for (const u of updated) await writeAudit(tx, ctx, patch.price !== undefined ? 'slot.reprice' : 'slot.block', 'slot', u.id, null, set as Record<string, unknown>);
    return updated;
  });
}

export async function holdSlots(slotIds: string[]): Promise<void> {
  await db.update(slots).set({ status: 'held', holdExpiresAt: sql`now() + interval '5 minutes'` })
    .where(sql`${slots.id} = any(${slotIds}) and ${slots.status} = 'open'`);
}
export async function releaseHold(slotIds: string[]): Promise<void> {
  await db.update(slots).set({ status: 'open', holdExpiresAt: null })
    .where(sql`${slots.id} = any(${slotIds}) and ${slots.status} = 'held'`);
}
```

- [ ] **Step 2: Write failing tests** `slot_service.test.ts` (`RUN_INTEGRATION` gated; set up tenant→venue→arena via existing services with a stub user id). Cases:
  - `enumerateOccurrences` (pure): a Sat-only cell over a 2-week window yields 2 occurrences at correct IST times.
  - `releaseSlots` creates N slots; prices seeded from a `pricing_rules` default rule; a re-release over the same window `skipped`>0 (overlap).
  - `bulkUpdateSlots` re-prices open slots + writes audit rows; throws `slot_locked` when a slot is `booked`.

- [ ] **Step 3: Run** `RUN_INTEGRATION=1 pnpm --filter @circls/api test src/services/slot_service.test.ts` → PASS.

- [ ] **Step 4: Commit** — `"phase-A4: slot_service (release/list/bulk/holds) + tests"`

### Task 5: booking_service — atomic multi-slot booking + cancel

**Files:** Create `apps/api/src/services/booking_service.ts`; Test: `apps/api/src/routes/bookings_slots.test.ts` (via routes, Task 6).

- [ ] **Step 1: Write `booking_service.ts`**

```ts
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type Booking, bookings, slots } from '../db/schema/index.js';
import { Conflict, NotFound } from '../lib/errors.js';
import { writeAudit, type AuditCtx } from '../lib/audit.js';

export interface BookSlotsInput { slotIds: string[]; customerName: string; customerContact: string; note?: string | null; }

export async function bookSlots(ctx: AuditCtx, venueId: string, input: BookSlotsInput): Promise<Booking> {
  if (input.slotIds.length === 0) throw new Conflict('No slots selected', 'no_slots');
  return db.transaction(async (tx) => {
    const sel = await tx.select().from(slots)
      .where(sql`${slots.id} = any(${input.slotIds}) and ${slots.tenantId} = ${ctx.tenantId} and ${slots.deletedAt} is null`);
    const total = sel.reduce((s, r) => s + r.pricePaise, 0);
    const [booking] = await tx.insert(bookings).values({
      tenantId: ctx.tenantId, venueId, itemType: 'slot', channel: 'walkin', paymentMethod: 'external',
      status: 'confirmed', customerName: input.customerName, customerContact: input.customerContact,
      note: input.note ?? null, totalPaise: total, createdByUserId: ctx.actorUserId,
    }).returning();
    // atomic claim: only open OR expired-held slots flip to booked
    const claimed = await tx.update(slots)
      .set({ status: 'booked', bookingId: booking!.id, holdExpiresAt: null })
      .where(sql`${slots.id} = any(${input.slotIds}) and ${slots.deletedAt} is null
        and (${slots.status} = 'open' or (${slots.status} = 'held' and ${slots.holdExpiresAt} < now()))`)
      .returning();
    if (claimed.length !== input.slotIds.length) throw new Conflict('Slot already taken', 'slot_taken');
    await writeAudit(tx, ctx, 'booking.create', 'booking', booking!.id, null, { slotIds: input.slotIds, total });
    return booking!;
  });
}

export async function cancelBooking(ctx: AuditCtx, bookingId: string): Promise<Booking> {
  return db.transaction(async (tx) => {
    const [b] = await tx.update(bookings).set({ status: 'cancelled' })
      .where(sql`${bookings.id} = ${bookingId} and ${bookings.tenantId} = ${ctx.tenantId}`).returning();
    if (!b) throw new NotFound('Booking not found', 'booking_not_found');
    await tx.update(slots).set({ status: 'open', bookingId: null }).where(eq(slots.bookingId, bookingId));
    await writeAudit(tx, ctx, 'booking.cancel', 'booking', bookingId, null, null);
    return b;
  });
}
```
> Throwing inside the tx rolls back the booking insert too, so a failed claim leaves no orphan booking.

- [ ] **Step 2: typecheck** — `pnpm --filter @circls/api typecheck` (tests land in Task 6).
- [ ] **Step 3: Commit** — `"phase-A5: booking_service multi-slot atomic booking + cancel"`

### Task 6: Routes + registration + route tests

**Files:** Create `apps/api/src/routes/slots.ts`; Modify `apps/api/src/routes/bookings.ts`, `apps/api/src/server.ts`; Test: `apps/api/src/routes/slots.test.ts`, `apps/api/src/routes/bookings_slots.test.ts`.

- [ ] **Step 1: Write `routes/slots.ts`** — endpoints (all `preHandler: requireAuth`, resolve `currentUser` + `requireTenantMembership` via arena→venue→tenant, mirroring `routes/arenas.ts` `authorizeArena`):
  - `POST /v1/arenas/:arenaId/slots/release` — body validated with zod (`startDate`/`endDate` datetime, `quantizationMin` int, `cells[]`); require `Idempotency-Key` (reuse `withIdempotency`); call `releaseSlots`.
  - `GET /v1/arenas/:arenaId/slots?from&to` — `listSlots`.
  - `PATCH /v1/slots/bulk` — body `{ slotIds[], price?, blocked? }`; resolve tenant from the first slot's arena; `bulkUpdateSlots`.
  - `POST /v1/slots/hold` / `POST /v1/slots/release-hold` — `{ slotIds[] }`.
- [ ] **Step 2: Modify `routes/bookings.ts`** — add `POST /v1/bookings` slot variant: body `{ slotIds[], customer:{name,contact,note?} }`, require Idempotency-Key, resolve venue via the slots' arena, call `bookSlots`; and `POST /v1/bookings/:id/cancel` → `cancelBooking`. (Keep or remove the old walk-in `createSlotBooking` path; remove it to avoid two booking models — delete the legacy body branch.)
- [ ] **Step 3: Register** `slotRoutes` in `server.ts`.
- [ ] **Step 4: Write failing route tests** `bookings_slots.test.ts`: set up tenant→venue→arena, release slots, then:
  - book 2 slots → 201, `totalPaise` = sum, both slots `booked`;
  - **concurrency**: two `Promise.all` bookings of the same slot set → exactly one 201, one 409 `slot_taken`;
  - non-member → 403; cancel → slots back to `open`, re-book succeeds; bulk re-price a booked slot → 409 `slot_locked`.
- [ ] **Step 5: Run** full suite `RUN_INTEGRATION=1 pnpm --filter @circls/api test` → all PASS; `pnpm --filter @circls/api typecheck` clean; `pnpm --filter @circls/api build`.
- [ ] **Step 6: Commit + push** — `"phase-A6: slots/booking routes + integration tests"` then `git push origin main`.

---

## PHASE 2 — Frontend foundation (shell, primitives, onboarding)

> Verification for all Phase 2-5 tasks: `pnpm --filter @circls/partners typecheck` and `pnpm --filter @circls/partners build` must be clean; visual/login QA is manual (noted). Commit per task.

### Task 7: Design tokens + UI primitives

**Files:** Modify `apps/partners/app/globals.css`; Create `apps/partners/lib/ui/{Button,Card,Input,Modal,Badge}.tsx`.

- [ ] **Step 1:** In `globals.css`, define tokens in `@theme` (brand `--color-brand-{50..700}`, neutral grays, `--radius`), set base body bg `#f8fafc`, font stack. Keep `@import "tailwindcss"`.
- [ ] **Step 2:** Write each primitive as a typed client component using Tailwind classes from the mockups (Button: variants `primary|ghost|danger`, sizes; Card: bordered white rounded; Input: labeled; Badge: status colors open/held/blocked/booked; Modal: portal + overlay + Esc/click-out close). Each file < 60 lines, props typed, no business logic.
- [ ] **Step 3:** `pnpm --filter @circls/partners build` → clean. Commit `"phase-B7: design tokens + UI primitives"`.

### Task 8: Sidebar shell + OrgSwitcher

**Files:** Rewrite `apps/partners/app/(protected)/layout.tsx`; Create `apps/partners/components/OrgSwitcher.tsx`; extend `lib/api/queries.ts` (`useMyTenants` exists).

- [ ] **Step 1:** Rewrite the protected layout to the **left-sidebar shell** (mockup A): fixed left rail (`circls` wordmark; nav links Dashboard `/dashboard`, Venues `/venues`, Bookings `/bookings`, Settings `/settings`), top bar with `<OrgSwitcher>` + sign-out. Keep the existing client auth-gate (`useAuth`, redirect to `/login`). Active-link styling via `usePathname()`.
- [ ] **Step 2:** `OrgSwitcher` — `useMyTenants()`, dropdown of tenants, stores the active tenantId in React context (`lib/org_context.tsx`, new) so pages read the current org. Default to first tenant.
- [ ] **Step 3:** build clean. Commit `"phase-B8: sidebar shell + org switcher + org context"`.

### Task 9: Self sign-up + onboarding wizard

**Files:** Create `app/(protected)/onboarding/page.tsx` (+ steps), reuse `useCreateTenant/useCreateVenue/useCreateArena`. Modify `app/(protected)/dashboard/page.tsx` to redirect to onboarding when `useMyTenants()` is empty.

- [ ] **Step 1:** Onboarding page: a stepper (Create org → Add venue → Add arena → Set schedule), each step optional/skippable, progress bar, "Do this later" → dashboard. Step 1 = org name+slug (`useCreateTenant`); on success set active org. Steps 2-3 reuse existing create hooks. Step 4 links to the schedule builder (Task 11).
- [ ] **Step 2:** Dashboard: if `useMyTenants()` returns `[]`, `router.replace('/onboarding')`.
- [ ] **Step 3:** build clean. Commit `"phase-B9: self sign-up + onboarding wizard"`.

---

## PHASE 3 — Matrix + schedule builder

### Task 10: `<Matrix>` component

**Files:** Create `apps/partners/components/Matrix.tsx`; types in `lib/api/types.ts` (add `Slot`).

- [ ] **Step 1:** Add `Slot` type to `types.ts` matching the API (`id, arenaId, timeRange, pricePaise, status, bookingId`).
- [ ] **Step 2:** Build `<Matrix>` (grid+inspector, mockup B): props `{ slots: Slot[]; weekStart: Date; mode: 'builder'|'reception'; onBulk(slotIds, patch); onBook(slotIds); onCancel(bookingId); onPrevWeek(); onNextWeek(); }`. Renders a CSS-grid: time-rows × 7 day-cols; each cell colored by status (Badge palette) showing `₹price` or status; **drag-select** (pointer events) + **click day/time header** to select a whole column/row; selection drives a right **inspector** panel (count, price field, Block toggle, Add booking button → calls `onBook`). Keep it presentational — no fetching inside. < 250 lines; if larger, split selection logic into `useGridSelection.ts`.
- [ ] **Step 3:** build clean. Commit `"phase-C10: reusable Matrix grid+inspector component"`.

### Task 11: Schedule builder page

**Files:** Create `app/(protected)/arenas/[arenaId]/schedule/page.tsx`; add mutations to `queries.ts` (`useReleaseSlots`, `useArenaSlots`).

- [ ] **Step 1:** Add hooks: `useArenaSlots(arenaId, fromIso, toIso)` (GET slots), `useReleaseSlots(arenaId)` (POST release with auto Idempotency-Key), `useBulkSlots(arenaId)` (PATCH /v1/slots/bulk).
- [ ] **Step 2:** Builder page: form (start date, end date, quantization select 30/60/90, default price) → on "Build preview" generate the in-memory cell grid (client-side enumerate from quantization across a representative week) and render `<Matrix mode="builder">` letting the owner edit prices/block per cell; **"Release"** posts `/slots/release` with the edited cells → toast with `{created, skipped}`.
- [ ] **Step 3:** build clean. Commit `"phase-C11: schedule builder (release)"`.

---

## PHASE 4 — Reception matrix + booking

### Task 12: Reception matrix page

**Files:** Rewrite `app/(protected)/arenas/[arenaId]/page.tsx`; mutations `useHold/useReleaseHold/useBulkSlots`.

- [ ] **Step 1:** Reception page: week pager state → `useArenaSlots` → `<Matrix mode="reception">`. Inspector "Add booking" opens `<AddBookingModal>` (Task 13). Re-price/block via `useBulkSlots`. Loading/empty/error states with primitives.
- [ ] **Step 2:** build clean. Commit `"phase-D12: reception matrix page"`.

### Task 13: Add Booking modal + cancel + confirm dialogs

**Files:** Create `components/AddBookingModal.tsx`, `components/ConfirmDialog.tsx`; hooks `useBookSlots`, `useCancelBooking`.

- [ ] **Step 1:** `ConfirmDialog` — generic confirm (title, body, danger button) using `<Modal>`.
- [ ] **Step 2:** `AddBookingModal` — props `{ slotIds, totalPaise, onClose }`; on open calls `useHold(slotIds)`; form (customer name, contact, optional note); shows total; submit → `useBookSlots({slotIds, customer})` → on success close + invalidate slots; on close without booking → `useReleaseHold`. Error surface: `slot_taken` → "Some slots were just taken — refreshing."
- [ ] **Step 3:** Wire cancel: clicking a booked cell → `ConfirmDialog` → `useCancelBooking`. Wire a confirm before bulk re-pricing as well.
- [ ] **Step 4:** build clean. Commit + push `"phase-D13: add-booking modal + cancel/confirm"`.

---

## PHASE 5 — Dashboard

### Task 14: Dashboard shell + placeholder stats

**Files:** Rewrite `app/(protected)/dashboard/page.tsx`.

- [ ] **Step 1:** Dashboard: greeting + 3 stat `<Card>`s (Bookings today / Revenue 7d / Occupancy) wired to a simple client aggregation over `useArenaSlots` for the active org's venues *(or static placeholders labeled "preview" — real analytics is a later slice)*; list of venues (existing `useVenues`) as cards linking to the reception matrix.
- [ ] **Step 2:** build clean. Commit + push `"phase-E14: dashboard shell + placeholder stats"`.

---

## Self-review checklist (run before execution)
- Spec §5 data model → Tasks 1-2. §6 API → Tasks 4-6. §7 concurrency → Tasks 5-6 tests. §8 frontend → Tasks 7-14. §10 testing → backend tests in Tasks 1,4,6.
- Holds-without-worker (§7): implemented in `bookSlots` predicate (Task 5) + `holdSlots`/`releaseHold` (Task 4). No worker dependency. ✓
- Type consistency: `AuditCtx`, `ReleaseCell`, `BookSlotsInput`, `Slot` defined once and reused. ✓
