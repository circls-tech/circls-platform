# Ticket Tiers for Events — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let partners define per-tier-priced, per-tier-capped ticket tiers on an event, and let web consumers buy multiple tickets across multiple tiers in a single per-event checkout.

**Architecture:** Two new tables — `event_ticket_tiers` (tier definitions) and `event_booking_tickets` (booking↔tier line items). A booking stays ONE ledger row per checkout (one Razorpay order), exactly like multi-slot booking; the per-tier breakdown lives in the line table, which is also the sole source of per-tier sold counts. Tiers are embedded in the draft-only event create/update payloads (replace-all). Existing events are auto-migrated into one default "General Admission" tier. `events.price_paise`/`capacity` become legacy; `price_paise` is kept in sync as the min tier price for cheap list display.

**Tech Stack:** TypeScript, Fastify, Drizzle ORM (Postgres), Zod, Next.js (App Router) + React Query + Tailwind (consumer & partners apps), Vitest.

**Reference spec:** `docs/superpowers/specs/2026-06-18-ticket-tiers-design.md`

**Conventions used throughout:**
- Money is paise (`bigintPaise`). Tables use `uuidv7()` PK default, `created_at`/`updated_at` `timestamptz default now()`.
- Migrations are hand-authored SQL in `apps/api/src/db/migrations/`. **Do NOT hardcode the migration number on this branch** — use the next free number when writing, and renumber at merge (per repo memory `migration-numbering-parallel-agents`). This plan uses `00XX` as the placeholder filename; pick the real next number (after `0022_coupons.sql`) when creating it.
- Backend tests are integration tests gated by `RUN_INTEGRATION=1` + a real `DATABASE_URL` (see `apps/api/vitest.setup.ts`). Locally there is usually no DB, so `pnpm --filter @circls/api test` runs and **skips** the integration suites. Each backend task therefore verifies via (a) `pnpm --filter @circls/api typecheck` and (b) `pnpm --filter @circls/api test` (must stay green / skipped, never error on import). Where a DB is available, run with `RUN_INTEGRATION=1 DATABASE_URL=… pnpm --filter @circls/api test <file>`.
- Run commands from the repo root. If `pnpm --filter` names differ, use the app dir (`cd apps/api && pnpm test`) — confirm the package name in `apps/api/package.json` first (`@circls/api` assumed).

---

## File Structure

**Backend (`apps/api`):**
- Create `src/db/schema/event_ticket_tiers.ts` — tier table + types.
- Create `src/db/schema/event_booking_tickets.ts` — line-item table + types.
- Modify `src/db/schema/index.ts` — barrel exports.
- Create `src/db/migrations/00XX_ticket_tiers.sql` — schema + data backfill.
- Create `src/services/event_tiers_service.ts` — tier read/write helpers (list with sold/remaining, replace-all writer, per-tier sold counts).
- Modify `src/services/events_service.ts` — write tiers in create/update; return tiers in reads.
- Modify `src/services/coupon_service.ts` — `priceItem` lines support.
- Modify `src/services/booking_service.ts` — `bookEvent` accepts lines, per-tier capacity, line inserts.
- Modify `src/services/consumer_service.ts` — `consumerBookEvent` passes lines; event readers attach tiers.
- Modify `src/routes/events.ts` — `tiers` in create/update schemas.
- Modify `src/routes/checkout.ts` — `lines` in quote schema.
- Modify `src/routes/bookings.ts` and `src/routes/consumer.ts` — `lines` in book schemas.
- Tests: `src/services/event_tiers_service.test.ts`, extend `src/routes/events.test.ts`, `src/routes/checkout.test.ts`, `src/routes/bookings.test.ts`.

**Consumer web (`apps/consumer`):**
- Modify `lib/api/types.ts` — `PublicTier`, tiers on `PublicEvent`/`PublicEventWithVenue`.
- Modify `lib/api/consumer.ts` — `BookEventInput.lines`.
- Modify `lib/api/checkout.ts` — `QuoteItem` event lines.
- Modify `lib/checkout/types.ts` — `CheckoutItem` event lines.
- Modify `lib/checkout/CheckoutModal.tsx` — pass lines; render per-tier rows.
- Modify `app/events/[id]/page.tsx` — tier selector + subtotal + CTA.

**Partners (`apps/partners`):**
- Create `app/(protected)/_components/TiersEditor.tsx` (or nearest shared components dir) — repeatable tiers editor.
- Modify the 4 event form pages to use it (`events/new`, `events/[eventId]`, `venues/[venueId]/events/new`, `venues/[venueId]/events/[eventId]`).
- Modify the partner event API hook/types to send `tiers` and read tier sold counts.
- Registrations view: per-tier sold counts.

**Docs:**
- Modify `apps/partners/content/help/events.md` (+ check `apps/partners/lib/help/articles.ts`).

---

## Phase 1 — Schema & migration

### Task 1: Drizzle schema for the two new tables

**Files:**
- Create: `apps/api/src/db/schema/event_ticket_tiers.ts`
- Create: `apps/api/src/db/schema/event_booking_tickets.ts`
- Modify: `apps/api/src/db/schema/index.ts`

- [ ] **Step 1: Create `event_ticket_tiers.ts`**

```ts
import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { bigintPaise, createdAt, updatedAt, uuidPk } from './_columns.js';
import { events } from './events.js';
import { tenants } from './tenants.js';

/**
 * A purchasable ticket tier within an event (Phase: ticket tiers). Each tier has
 * its own price and its own capacity (null = unlimited). Per-tier sold counts are
 * derived from event_booking_tickets, not stored here. Tiers are editable only
 * while the parent event is draft (replace-all from the event payload), and are
 * soft-deleted (deletedAt) when removed so historical bookings keep referencing
 * the tier they were sold under.
 */
export const eventTicketTiers = pgTable('event_ticket_tiers', {
  id: uuidPk(),
  eventId: uuid('event_id')
    .notNull()
    .references(() => events.id, { onDelete: 'cascade' }),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  name: text('name').notNull(),
  description: text('description'),
  pricePaise: bigintPaise('price_paise').notNull().default(0),
  /** null = unlimited capacity for this tier. */
  capacity: integer('capacity'),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export type EventTicketTier = typeof eventTicketTiers.$inferSelect;
export type NewEventTicketTier = typeof eventTicketTiers.$inferInsert;
```

- [ ] **Step 2: Create `event_booking_tickets.ts`**

```ts
import { integer, pgTable, uuid } from 'drizzle-orm/pg-core';
import { bigintPaise, createdAt, uuidPk } from './_columns.js';
import { bookings } from './bookings.js';
import { eventTicketTiers } from './event_ticket_tiers.js';

/**
 * Line item linking one booking to one ticket tier with a quantity (Phase:
 * ticket tiers). A single event booking is still ONE bookings row; its tier
 * breakdown is the set of these lines. This table is the SOLE source of per-tier
 * sold counts: SUM(quantity) over lines whose booking is not cancelled.
 */
export const eventBookingTickets = pgTable('event_booking_tickets', {
  id: uuidPk(),
  bookingId: uuid('booking_id')
    .notNull()
    .references(() => bookings.id, { onDelete: 'cascade' }),
  tierId: uuid('tier_id')
    .notNull()
    .references(() => eventTicketTiers.id),
  quantity: integer('quantity').notNull(),
  /** Price per ticket at purchase time (snapshot; tier price may change later). */
  unitPricePaise: bigintPaise('unit_price_paise').notNull(),
  createdAt: createdAt(),
});

export type EventBookingTicket = typeof eventBookingTickets.$inferSelect;
export type NewEventBookingTicket = typeof eventBookingTickets.$inferInsert;
```

- [ ] **Step 3: Add barrel exports**

In `apps/api/src/db/schema/index.ts`, after the `export * from './events.js';` line add:

```ts
export * from './event_ticket_tiers.js';
export * from './event_booking_tickets.js';
```

- [ ] **Step 4: Verify it compiles**

Run: `cd apps/api && pnpm typecheck`
Expected: PASS (no errors). If `_columns.js` does not export `bigintPaise`/`createdAt`/`updatedAt`/`uuidPk`, open `apps/api/src/db/schema/_columns.ts` and use the exact exported names — the existing `events.ts`/`bookings.ts` import these same four, so they must exist.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/schema/event_ticket_tiers.ts apps/api/src/db/schema/event_booking_tickets.ts apps/api/src/db/schema/index.ts
git commit -m "feat(api): ticket tier + booking-line tables (schema)"
```

---

### Task 2: Migration — create tables + backfill existing events

**Files:**
- Create: `apps/api/src/db/migrations/00XX_ticket_tiers.sql` (use the next free number after `0022`; do not assume — `ls apps/api/src/db/migrations/` first).

- [ ] **Step 1: Determine the next migration number**

Run: `ls apps/api/src/db/migrations/*.sql | sort | tail -1`
Take the number, add 1, name the file `00XX_ticket_tiers.sql`. Also append an entry to `apps/api/src/db/migrations/meta/_journal.json` only if the project's other migrations have journal entries — inspect an existing entry first; if migrations are applied purely by filename order via `src/migrate.ts`, no journal edit is needed. (Confirm by reading `apps/api/src/migrate.ts`.)

- [ ] **Step 2: Write the migration SQL**

```sql
-- Ticket tiers: per-event, per-tier price + capacity. A booking stays one row;
-- its tier breakdown lives in event_booking_tickets (also the source of per-tier
-- sold counts). Existing events are backfilled into one "General Admission" tier
-- and existing non-cancelled event bookings get a matching line so per-tier sold
-- counts stay correct. events.price_paise/capacity become legacy; price_paise is
-- kept in sync (min tier price) by the app for list display.

CREATE TABLE "event_ticket_tiers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"event_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"price_paise" bigint DEFAULT 0 NOT NULL,
	"capacity" integer,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "event_booking_tickets" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"booking_id" uuid NOT NULL,
	"tier_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price_paise" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_booking_tickets_qty_chk" CHECK ("quantity" > 0)
);
--> statement-breakpoint
ALTER TABLE "event_ticket_tiers" ADD CONSTRAINT "event_ticket_tiers_event_id_events_id_fk"
	FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "event_ticket_tiers" ADD CONSTRAINT "event_ticket_tiers_tenant_id_tenants_id_fk"
	FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "event_booking_tickets" ADD CONSTRAINT "event_booking_tickets_booking_id_bookings_id_fk"
	FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "event_booking_tickets" ADD CONSTRAINT "event_booking_tickets_tier_id_event_ticket_tiers_id_fk"
	FOREIGN KEY ("tier_id") REFERENCES "public"."event_ticket_tiers"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "event_ticket_tiers_event_id_idx" ON "event_ticket_tiers" ("event_id");
--> statement-breakpoint
CREATE INDEX "event_booking_tickets_tier_id_idx" ON "event_booking_tickets" ("tier_id");
--> statement-breakpoint
CREATE INDEX "event_booking_tickets_booking_id_idx" ON "event_booking_tickets" ("booking_id");
--> statement-breakpoint
-- Backfill: one default tier per existing event.
INSERT INTO "event_ticket_tiers" ("event_id", "tenant_id", "name", "price_paise", "capacity", "sort_order")
SELECT e."id", e."tenant_id", 'General Admission', e."price_paise", e."capacity", 0
FROM "events" e;
--> statement-breakpoint
-- Backfill: one line per existing non-cancelled event booking, against that
-- event's default tier (the only tier each event now has).
INSERT INTO "event_booking_tickets" ("booking_id", "tier_id", "quantity", "unit_price_paise")
SELECT b."id", t."id", 1, COALESCE(b."base_paise", b."price_paise", 0)
FROM "bookings" b
JOIN "event_ticket_tiers" t ON t."event_id" = (b."item_data"->>'eventId')::uuid
WHERE b."item_type" = 'event' AND b."status" <> 'cancelled';
--> statement-breakpoint
-- Keep events.price_paise as the min tier price (no-op for single-tier today).
UPDATE "events" e
SET "price_paise" = sub.min_price
FROM (
	SELECT "event_id", MIN("price_paise") AS min_price
	FROM "event_ticket_tiers" WHERE "deleted_at" IS NULL GROUP BY "event_id"
) sub
WHERE sub."event_id" = e."id";
```

> Note: this SQL uses `uuidv7()` and the same FK-naming style as `0022_coupons.sql`. If `drizzle-kit generate` is the team norm, you may instead run `cd apps/api && pnpm db:generate` to emit the table DDL, then hand-append the three backfill statements; either way the final file must match the schema in Task 1.

- [ ] **Step 3: Verify the migration applies (only where a DB is available)**

Run: `cd apps/api && DATABASE_URL=<dev db> pnpm db:migrate`
Expected: migration runs without error; `SELECT count(*) FROM event_ticket_tiers` equals the event count. If no DB is available, skip — the SQL is reviewed in Task 17 and exercised by integration tests.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/db/migrations/
git commit -m "feat(api): migration for ticket tiers + backfill default tier"
```

---

## Phase 2 — Backend service layer

### Task 3: Tier service — list-with-remaining, sold counts, replace-all writer

**Files:**
- Create: `apps/api/src/services/event_tiers_service.ts`
- Test: `apps/api/src/services/event_tiers_service.test.ts`

- [ ] **Step 1: Write the service**

```ts
/**
 * Ticket-tier service. Tiers belong to an event; per-tier sold counts come from
 * event_booking_tickets. Writes are replace-all and only valid while the event
 * is draft (the caller — events_service — enforces draft). All write helpers take
 * a transaction handle so they compose inside the event create/update tx.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { db as Db } from '../db/client.js';
import { eventBookingTickets } from '../db/schema/event_booking_tickets.js';
import { eventTicketTiers, type EventTicketTier } from '../db/schema/event_ticket_tiers.js';
import { events } from '../db/schema/events.js';
import { bookings } from '../db/schema/bookings.js';
import { BadRequest } from '../lib/errors.js';

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0];

export interface TierInput {
  name: string;
  description?: string | null;
  pricePaise: number;
  capacity?: number | null;
}

export interface TierWithRemaining extends EventTicketTier {
  sold: number;
  /** capacity - sold, or null when the tier is uncapped. */
  remaining: number | null;
}

/** Live (non-deleted) tiers for an event, ordered for display. */
export async function listTiers(database: typeof Db, eventId: string): Promise<EventTicketTier[]> {
  return database
    .select()
    .from(eventTicketTiers)
    .where(and(eq(eventTicketTiers.eventId, eventId), isNull(eventTicketTiers.deletedAt)))
    .orderBy(eventTicketTiers.sortOrder, eventTicketTiers.createdAt);
}

/** Per-tier sold counts for the given tier ids (non-cancelled bookings only). */
export async function soldByTier(
  database: typeof Db,
  tierIds: string[],
): Promise<Map<string, number>> {
  if (tierIds.length === 0) return new Map();
  const rows = await database
    .select({
      tierId: eventBookingTickets.tierId,
      sold: sql<number>`coalesce(sum(${eventBookingTickets.quantity}), 0)::int`,
    })
    .from(eventBookingTickets)
    .innerJoin(bookings, eq(bookings.id, eventBookingTickets.bookingId))
    .where(
      and(
        inArray(eventBookingTickets.tierId, tierIds),
        sql`${bookings.status} <> 'cancelled'`,
      ),
    )
    .groupBy(eventBookingTickets.tierId);
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.tierId, r.sold);
  return map;
}

/** Live tiers enriched with sold/remaining (for consumer + partner reads). */
export async function listTiersWithRemaining(
  database: typeof Db,
  eventId: string,
): Promise<TierWithRemaining[]> {
  const tiers = await listTiers(database, eventId);
  const sold = await soldByTier(database, tiers.map((t) => t.id));
  return tiers.map((t) => {
    const s = sold.get(t.id) ?? 0;
    return { ...t, sold: s, remaining: t.capacity == null ? null : Math.max(0, t.capacity - s) };
  });
}

/**
 * Replace an event's tiers (draft-only; caller enforces). Soft-deletes tiers no
 * longer present and inserts the provided set fresh. We insert new rows rather
 * than updating existing ones so price/capacity edits never silently rewrite a
 * tier that historical bookings reference — but since this path is draft-only,
 * there are no bookings yet, so a clean soft-delete + insert is safe and simple.
 * Returns the new live tier set.
 */
export async function replaceTiers(
  tx: Tx,
  eventId: string,
  tenantId: string,
  tiers: TierInput[],
): Promise<EventTicketTier[]> {
  if (tiers.length === 0) {
    throw new BadRequest('An event needs at least one ticket tier', 'event_tiers_required');
  }
  await tx
    .update(eventTicketTiers)
    .set({ deletedAt: sql`now()` })
    .where(and(eq(eventTicketTiers.eventId, eventId), isNull(eventTicketTiers.deletedAt)));

  const inserted = await tx
    .insert(eventTicketTiers)
    .values(
      tiers.map((t, i) => ({
        eventId,
        tenantId,
        name: t.name,
        description: t.description ?? null,
        pricePaise: t.pricePaise,
        capacity: t.capacity ?? null,
        sortOrder: i,
      })),
    )
    .returning();

  // Keep events.price_paise as the min tier price for cheap list display.
  const minPrice = Math.min(...tiers.map((t) => t.pricePaise));
  await tx.update(events).set({ pricePaise: minPrice }).where(eq(events.id, eventId));

  return inserted;
}
```

- [ ] **Step 2: Write the test (integration; gated by RUN_INTEGRATION)**

`apps/api/src/services/event_tiers_service.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

const { closeDb, db } = await import('../db/client.js');
const { replaceTiers, listTiersWithRemaining, soldByTier } = await import('./event_tiers_service.js');

const runIntegration = Boolean(process.env.RUN_INTEGRATION);

describe.skipIf(!runIntegration)('event_tiers_service', () => {
  let tenantId: string;
  let eventId: string;

  beforeAll(async () => {
    const [t] = await db.execute<{ id: string }>(
      sql`insert into tenants (name, slug, status) values ('TierSvc', ${'tiersvc-' + Date.now()}, 'active') returning id`,
    );
    tenantId = t!.id;
    const [e] = await db.execute<{ id: string }>(
      sql`insert into events (tenant_id, name, starts_at, ends_at, price_paise, status, address_json, tz_name)
          values (${tenantId}, 'E', now() + interval '1 day', now() + interval '2 day', 0, 'draft', '{"city":"Pune"}', 'Asia/Kolkata') returning id`,
    );
    eventId = e!.id;
  });

  afterAll(async () => {
    await db.execute(sql`delete from event_booking_tickets where tier_id in (select id from event_ticket_tiers where event_id = ${eventId})`);
    await db.execute(sql`delete from event_ticket_tiers where event_id = ${eventId}`);
    await db.execute(sql`delete from events where id = ${eventId}`);
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
    await closeDb();
  });

  it('replaceTiers inserts tiers, syncs min price, and reports remaining', async () => {
    const tiers = await db.transaction((tx) =>
      replaceTiers(tx, eventId, tenantId, [
        { name: 'VIP', pricePaise: 50000, capacity: 2 },
        { name: 'GA', pricePaise: 20000, capacity: null },
      ]),
    );
    expect(tiers).toHaveLength(2);

    const withRemaining = await listTiersWithRemaining(db, eventId);
    const vip = withRemaining.find((t) => t.name === 'VIP')!;
    const ga = withRemaining.find((t) => t.name === 'GA')!;
    expect(vip.remaining).toBe(2);
    expect(ga.remaining).toBeNull();

    const [{ price_paise }] = await db.execute<{ price_paise: number }>(
      sql`select price_paise from events where id = ${eventId}`,
    );
    expect(Number(price_paise)).toBe(20000);
  });

  it('replaceTiers is replace-all (old tiers soft-deleted)', async () => {
    await db.transaction((tx) =>
      replaceTiers(tx, eventId, tenantId, [{ name: 'Only', pricePaise: 10000, capacity: 5 }]),
    );
    const live = await listTiersWithRemaining(db, eventId);
    expect(live.map((t) => t.name)).toEqual(['Only']);
  });

  it('replaceTiers rejects an empty tier set', async () => {
    await expect(db.transaction((tx) => replaceTiers(tx, eventId, tenantId, []))).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run typecheck + tests**

Run: `cd apps/api && pnpm typecheck && pnpm test`
Expected: typecheck PASS; `pnpm test` PASS with the new suite skipped (no `RUN_INTEGRATION`). If a DB is available: `RUN_INTEGRATION=1 DATABASE_URL=… pnpm test src/services/event_tiers_service.test.ts` → all 3 pass.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/event_tiers_service.ts apps/api/src/services/event_tiers_service.test.ts
git commit -m "feat(api): event_tiers_service (list/remaining/sold/replace-all)"
```

---

### Task 4: Embed tiers in event create/update

**Files:**
- Modify: `apps/api/src/services/events_service.ts`

- [ ] **Step 1: Extend the create/update input types and write tiers**

In `events_service.ts`, import the tier service at the top with the other imports:

```ts
import { replaceTiers, type TierInput } from './event_tiers_service.js';
```

Add `tiers` to `CreateEventInput` (find the interface; it currently has `pricePaise`/`capacity`) and to `UpdateEventPatch`:

```ts
// CreateEventInput: add
  tiers: TierInput[];
// UpdateEventPatch: add
  tiers?: TierInput[];
```

In `createEvent`, inside the existing `db.transaction`, after the `events` row is inserted (`if (!row) throw …`), and before `writeAudit`, add:

```ts
    await replaceTiers(tx, row.id, input.tenantId, input.tiers);
```

`input.pricePaise`/`input.capacity` may still be passed by callers for now; `replaceTiers` overwrites `events.price_paise` with the min tier price, so the inserted single price is harmless. (Routes in Task 8 stop sending the standalone price.)

In `updateEvent`, inside the transaction, after the existing `if (Object.keys(set).length > 0) { … }` block and before re-selecting the updated row, add:

```ts
    if (patch.tiers !== undefined) {
      await replaceTiers(tx, eventId, ctx.tenantId, patch.tiers);
    }
```

- [ ] **Step 2: Return tiers from the single-event read**

Find `getEvent` in `events_service.ts` (used by `GET /v1/tenants/:tenantId/events/:id`). Change it to attach tiers with sold/remaining. Import:

```ts
import { listTiersWithRemaining } from './event_tiers_service.js';
```

Wrap its return so the event object includes `tiers`:

```ts
export async function getEvent(eventId: string, tenantId: string) {
  const [row] = await db
    .select()
    .from(events)
    .where(and(eq(events.id, eventId), eq(events.tenantId, tenantId)))
    .limit(1);
  if (!row) return null;
  const tiers = await listTiersWithRemaining(db, eventId);
  return { ...row, tiers };
}
```

(If `getEvent` already has a different shape, preserve it and just add the `tiers` property — read the current implementation first.)

- [ ] **Step 3: Typecheck**

Run: `cd apps/api && pnpm typecheck`
Expected: PASS. (Callers in `routes/events.ts` will be updated in Task 8; until then they may fail typecheck because `tiers` is now required on `CreateEventInput`. To keep this task self-contained, also do Task 8's schema change — OR temporarily make `tiers` optional and tighten it in Task 8. Prefer doing Task 8 immediately after.)

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/events_service.ts
git commit -m "feat(api): write/return ticket tiers in event create/update/get"
```

---

### Task 5: `priceItem` accepts tier lines

**Files:**
- Modify: `apps/api/src/services/coupon_service.ts`
- Test: extend `apps/api/src/routes/checkout.test.ts` (Task 9)

- [ ] **Step 1: Extend the event branch of `priceItem`**

In `coupon_service.ts`, change the `priceItem` signature's event variant to accept optional lines, and compute base from tiers. Add imports near the top (alongside the existing `events` import):

```ts
import { eventTicketTiers } from '../db/schema/event_ticket_tiers.js';
import { inArray, isNull } from 'drizzle-orm'; // add any not already imported
```

Replace the event branch (currently `if (req.itemType === 'event') { … return { …, basePaise: ev.pricePaise, … } }`) with:

```ts
  if (req.itemType === 'event') {
    const [ev] = await db.select().from(events).where(eq(events.id, req.eventId)).limit(1);
    if (!ev) throw new NotFound('Event not found', 'event_not_found');

    // With explicit lines (quote/booking): base = sum(tier price * qty), and the
    // referenced tiers must belong to this event and be live.
    if (req.lines && req.lines.length > 0) {
      const tierIds = req.lines.map((l) => l.tierId);
      const tiers = await db
        .select()
        .from(eventTicketTiers)
        .where(and(inArray(eventTicketTiers.id, tierIds), isNull(eventTicketTiers.deletedAt)));
      const byId = new Map(tiers.map((t) => [t.id, t]));
      let basePaise = 0;
      for (const line of req.lines) {
        const tier = byId.get(line.tierId);
        if (!tier || tier.eventId !== ev.id) {
          throw new BadRequest('Unknown ticket tier for this event', 'bad_request');
        }
        if (line.quantity <= 0) throw new BadRequest('Quantity must be positive', 'bad_request');
        basePaise += tier.pricePaise * line.quantity;
      }
      return { tenantId: ev.tenantId, basePaise, item: { type: 'event', id: ev.id, venueId: ev.venueId } };
    }

    // No lines (coupon-listing endpoint, which only needs a base to test
    // min-order): use the cheapest tier price as a safe lower bound.
    const live = await db
      .select({ p: eventTicketTiers.pricePaise })
      .from(eventTicketTiers)
      .where(and(eq(eventTicketTiers.eventId, ev.id), isNull(eventTicketTiers.deletedAt)));
    const basePaise = live.length ? Math.min(...live.map((r) => r.p)) : ev.pricePaise;
    return { tenantId: ev.tenantId, basePaise, item: { type: 'event', id: ev.id, venueId: ev.venueId } };
  }
```

Update the `priceItem` parameter type's event member to:

```ts
  | { itemType: 'event'; eventId: string; lines?: { tierId: string; quantity: number }[] }
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/api && pnpm typecheck`
Expected: PASS. (`and` is already imported in this file; add `inArray`/`isNull` only if not present.)

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/coupon_service.ts
git commit -m "feat(api): priceItem computes event base from tier lines"
```

---

### Task 6: `bookEvent` — per-tier capacity + line inserts

**Files:**
- Modify: `apps/api/src/services/booking_service.ts`
- Test: extend `apps/api/src/routes/bookings.test.ts` (Task 10)

- [ ] **Step 1: Add a `lines` param threaded into `bookEvent`**

In `booking_service.ts`, add imports:

```ts
import { eventBookingTickets } from '../db/schema/event_booking_tickets.js';
import { eventTicketTiers } from '../db/schema/event_ticket_tiers.js';
```

Find `bookEvent(eventId, customer, pricing?)`. Add a `lines` argument. Define the line shape near the top of the file:

```ts
export interface EventLine {
  tierId: string;
  quantity: number;
}
```

Change the signature to accept lines (keep `pricing` last to match existing callers, or add lines to the customer object — prefer an explicit param):

```ts
export async function bookEvent(
  eventId: string,
  customer: { userId: string; name?: string | null; contact?: string | null; note?: string | null },
  pricing: ... /* existing type */ | null,
  lines: EventLine[],
): Promise<...> {
```

- [ ] **Step 2: Replace the count-based capacity check with per-tier capacity (under row lock), compute base from tiers, insert booking + lines**

Inside the transaction, after `if (ev.status !== 'published') { … }` and the `ctx` setup, REMOVE the old `if (ev.capacity !== null) { count(*) … }` pre-check and the second post-insert recount, and REPLACE the base computation + booking insert with:

```ts
    if (lines.length === 0) throw new Conflict('No tickets selected', 'no_tickets');

    // Lock the referenced tiers (serialize concurrent buyers), validate, and
    // enforce per-tier capacity using the line-table sold count.
    const tierIds = lines.map((l) => l.tierId);
    const tiers = await tx
      .select()
      .from(eventTicketTiers)
      .where(
        and(
          inArray(eventTicketTiers.id, tierIds),
          eq(eventTicketTiers.eventId, eventId),
          sql`${eventTicketTiers.deletedAt} is null`,
        ),
      )
      .for('update');
    const tierById = new Map(tiers.map((t) => [t.id, t]));

    let basePaise = 0;
    const lineValues: { tierId: string; quantity: number; unitPricePaise: number }[] = [];
    for (const line of lines) {
      const tier = tierById.get(line.tierId);
      if (!tier) throw new BadRequest('Unknown ticket tier for this event', 'bad_request');
      if (line.quantity <= 0) throw new BadRequest('Quantity must be positive', 'bad_request');
      if (tier.capacity !== null) {
        const [{ sold }] = await tx
          .select({ sold: sql<number>`coalesce(sum(${eventBookingTickets.quantity}), 0)::int` })
          .from(eventBookingTickets)
          .innerJoin(bookings, eq(bookings.id, eventBookingTickets.bookingId))
          .where(and(eq(eventBookingTickets.tierId, tier.id), ne(bookings.status, 'cancelled')));
        if ((sold ?? 0) + line.quantity > tier.capacity) {
          throw new Conflict('Tier sold out', 'tier_sold_out', { tierId: tier.id });
        }
      }
      basePaise += tier.pricePaise * line.quantity;
      lineValues.push({ tierId: tier.id, quantity: line.quantity, unitPricePaise: tier.pricePaise });
    }
```

Then keep the existing money model but feed it the new `basePaise` (the line that currently reads `const basePaise = ev.pricePaise;` is now superseded — delete it; `basePaise` is already defined above). The `computeCheckout(basePaise, …)` call and `isFree`/`settleBasePaise` logic stay as-is.

After the `bookings` insert returns `b`, insert the line rows (replacing the old post-insert recount block):

```ts
    await tx.insert(eventBookingTickets).values(
      lineValues.map((l) => ({
        bookingId: b.id,
        tierId: l.tierId,
        quantity: l.quantity,
        unitPricePaise: l.unitPricePaise,
      })),
    );
```

Ensure `ne`, `inArray`, `sql`, `and`, `eq` are imported (most already are — add any missing). `BadRequest` is imported alongside `Conflict`/`NotFound`.

- [ ] **Step 3: Update the `Conflict` constructor call if it doesn't accept a details arg**

Open `apps/api/src/lib/errors.ts` and confirm `Conflict(message, code, details?)` accepts a third arg (the codebase uses `BadRequest('…', 'bad_request', { issues })`, so the base error supports details). If `Conflict` does not, add an optional `details` param matching `BadRequest`. Then `tier_sold_out` carries `{ tierId }`.

- [ ] **Step 4: Typecheck**

Run: `cd apps/api && pnpm typecheck`
Expected: PASS once callers (`consumerBookEvent`, the two routes) pass `lines` — done in Tasks 7 and 10. Do those next so the tree typechecks.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/booking_service.ts apps/api/src/lib/errors.ts
git commit -m "feat(api): bookEvent enforces per-tier capacity and writes ticket lines"
```

---

### Task 7: `consumerBookEvent` passes lines; consumer event reader attaches tiers

**Files:**
- Modify: `apps/api/src/services/consumer_service.ts`

- [ ] **Step 1: Thread `lines` through `consumerBookEvent`**

Change `consumerBookEvent(eventId, customer, couponCode?)` to accept lines:

```ts
import type { EventLine } from './booking_service.js';
import { listTiersWithRemaining } from './event_tiers_service.js';

export async function consumerBookEvent(
  eventId: string,
  customer: { userId: string; name?: string | null; contact?: string | null },
  lines: EventLine[],
  couponCode?: string,
): Promise<BookEventResult> {
  // …existing event + visibility checks unchanged…
  const pricing = couponCode
    ? await resolvePricing({ itemType: 'event', eventId, lines }, customer.userId, couponCode)
    : null;
  return bookEvent(eventId, customer, pricing, lines);
}
```

If `resolvePricing` forwards its first arg to `priceItem`, it now carries `lines` automatically; confirm its parameter type includes the event `lines` field (it should after Task 5 widened `priceItem`). If `resolvePricing` has its own narrower type, widen it to `{ itemType: 'event'; eventId: string; lines?: EventLine[] } | …`.

- [ ] **Step 2: Attach tiers to the public event readers**

Add `tiers` to `PublicEventWithVenue`:

```ts
import type { TierWithRemaining } from './event_tiers_service.js';

export interface PublicEventWithVenue extends Event {
  // …existing fields…
  tiers: TierWithRemaining[];
}
```

`getPublicEventById` returns a single event — enrich it with tiers before returning:

```ts
  if (!row) return null;
  const joinRow = row as EventJoinRow;
  const imagesByEvent = await imagesForEvents([joinRow.e.id]);
  const tiers = await listTiersWithRemaining(db, joinRow.e.id);
  return { ...toPublicEvent(joinRow, imagesByEvent.get(joinRow.e.id) ?? []), tiers };
```

For the list endpoint `listPublicUpcomingEvents`, attaching full tier sets per event would be N+1; the list only needs a "from ₹X" which is `events.price_paise` (kept synced to min tier price). So set `tiers: []` for list rows and rely on `pricePaise` for the card. Update `toPublicEvent` to default `tiers: []`, and only the detail path fills it:

```ts
function toPublicEvent(r: EventJoinRow, images: PublicImageRef[] = []): PublicEventWithVenue {
  // …existing…
  return { ...r.e, /* …existing… */, images, tiers: [] };
}
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/api && pnpm typecheck`
Expected: PASS for this file (route callers fixed in Task 10).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/consumer_service.ts
git commit -m "feat(api): consumer event reader returns tiers; book passes lines"
```

---

## Phase 3 — API route schemas

### Task 8: `tiers` in event create/update route schemas

**Files:**
- Modify: `apps/api/src/routes/events.ts`

- [ ] **Step 1: Add a shared tier zod schema and put it on the three event schemas**

Near the top of `events.ts`, after imports:

```ts
const tierSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  pricePaise: z.number().int().min(0),
  capacity: z.number().int().min(1).nullable().optional(),
});
const tiersField = z.array(tierSchema).min(1).max(20);
```

In `createEventSchema`: remove `pricePaise`/`capacity` lines and add `tiers: tiersField`. In `createTenantEventSchema`: same (remove `pricePaise`/`capacity`, add `tiers: tiersField`) — keep the three `.refine` scope rules. In `updateEventSchema`: remove `pricePaise`/`capacity`, add `tiers: tiersField.optional()`.

- [ ] **Step 2: Pass `tiers` through to the service in all three handlers**

In the `POST /v1/venues/:venueId/events`, `POST /v1/tenants/:tenantId/events`, and `PATCH /v1/tenants/:tenantId/events/:id` handlers, replace the `pricePaise: parsed.data.pricePaise, capacity: parsed.data.capacity,` arguments with `tiers: parsed.data.tiers,`. For the PATCH handler, pass `tiers: parsed.data.tiers` (which is `undefined` when omitted — `updateEvent` handles that).

`createEvent` still requires *some* `pricePaise` only if its input type kept it required — after Task 4, `CreateEventInput.pricePaise` should be removed/optional. Make `CreateEventInput.pricePaise`/`capacity` optional (or delete them) so routes need not send them; `replaceTiers` sets `events.price_paise`.

- [ ] **Step 3: Typecheck + run existing event tests**

Run: `cd apps/api && pnpm typecheck && pnpm test src/routes/events.test.ts`
Expected: typecheck PASS. The existing `events.test.ts` payloads send `pricePaise` but no `tiers` — they will now 400. Update those payloads in this step: replace `pricePaise: 0` with `tiers: [{ name: 'General', pricePaise: 0 }]` in each create payload, and add an assertion `expect(ev.tiers?.length ?? 1).toBeGreaterThanOrEqual(1)` where the GET-by-id is checked. (Under `RUN_INTEGRATION` these now pass; without it, skipped.)

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/events.ts apps/api/src/routes/events.test.ts
git commit -m "feat(api): event create/update routes accept ticket tiers"
```

---

### Task 9: `lines` in the checkout quote schema

**Files:**
- Modify: `apps/api/src/routes/checkout.ts`
- Test: `apps/api/src/routes/checkout.test.ts`

- [ ] **Step 1: Add lines to the event quote variant**

In `checkout.ts`, change the event member of `itemSchema`:

```ts
const itemSchema = z.union([
  z.object({
    itemType: z.literal('event'),
    eventId: z.string().uuid(),
    lines: z.array(z.object({ tierId: z.string().uuid(), quantity: z.number().int().min(1) })).min(1),
  }),
  z.object({ itemType: z.literal('membership'), membershipId: z.string().uuid() }),
  z.object({ itemType: z.literal('slot'), slotIds: z.array(z.string().uuid()).min(1) }),
]);
```

`priceItem(parsed.data)` already forwards the parsed object, which now carries `lines` — no further change in the handler (Task 5 made `priceItem` read `lines`). The coupon-listing endpoint passes `{ itemType: 'event', eventId }` with no lines and uses the min-tier fallback — leave it.

- [ ] **Step 2: Add a quote test**

In `checkout.test.ts`, inside the integration describe block, add a test that creates a published event with two tiers (seed via `db.execute` or the routes), then:

```ts
it('quotes a multi-tier event cart by summing tier price * qty', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/consumer/checkout/quote',
    headers: bearer('user'),
    payload: { itemType: 'event', eventId, lines: [
      { tierId: vipTierId, quantity: 2 },
      { tierId: gaTierId, quantity: 1 },
    ] },
  });
  expect(res.statusCode).toBe(200);
  const q = res.json();
  expect(q.basePaise).toBe(2 * 50000 + 1 * 20000);
});
```

(Use whatever seeding helper the file already has; mirror its existing event setup.)

- [ ] **Step 3: Typecheck + test**

Run: `cd apps/api && pnpm typecheck && pnpm test src/routes/checkout.test.ts`
Expected: typecheck PASS; suite skipped without `RUN_INTEGRATION`, passes with it.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/checkout.ts apps/api/src/routes/checkout.test.ts
git commit -m "feat(api): checkout quote accepts multi-tier event lines"
```

---

### Task 10: `lines` in the book routes

**Files:**
- Modify: `apps/api/src/routes/consumer.ts` (the route the web app uses)
- Modify: `apps/api/src/routes/bookings.ts` (the sibling `/v1/events/:id/book` route)
- Test: extend `apps/api/src/routes/bookings.test.ts`

- [ ] **Step 1: Consumer book route — add lines**

In `consumer.ts`, extend `bookEventBody` (around line 146) and pass lines:

```ts
const bookEventBody = z.object({
  customer: z.object({ name: z.string().optional(), contact: z.string().optional() }).optional(),
  couponCode: z.string().min(1).max(64).optional(),
  lines: z.array(z.object({ tierId: z.string().uuid(), quantity: z.number().int().min(1) })).min(1),
});
```

In the handler (line 151), pass lines to `consumerBookEvent`:

```ts
return consumerBookEvent(
  eventId,
  { userId: user.id, name: parsed.data.customer?.name ?? null, contact: parsed.data.customer?.contact ?? null },
  parsed.data.lines,
  parsed.data.couponCode,
);
```

(Match the existing arg names — read the current call first; only the new `lines` arg and its position relative to `couponCode` matter per Task 7's signature.)

- [ ] **Step 2: Sibling book route — add lines**

In `bookings.ts`, extend `bookEventSchema` to include `lines` (same shape, `.min(1)`), and pass `parsed.data.lines` as the new 4th arg to `bookEvent(eventId, { … }, null, parsed.data.lines)`. (This route calls `bookEvent` directly with no coupon; pricing arg stays `null` unless it already resolves one.)

- [ ] **Step 3: Add booking tests**

In `bookings.test.ts` integration block, add: (a) a multi-tier booking creates one booking + two `event_booking_tickets` rows with correct `unit_price_paise` and `quantity`, and `base_paise` = sum; (b) booking beyond a tier's capacity returns 409 `tier_sold_out`:

```ts
it('books multiple tiers in one order', async () => {
  const res = await app.inject({ method: 'POST', url: `/v1/consumer/events/${eventId}/book`,
    headers: bearer('user'),
    payload: { lines: [{ tierId: vipTierId, quantity: 1 }, { tierId: gaTierId, quantity: 2 }] } });
  expect(res.statusCode).toBe(200);
  const bookingId = res.json().booking.id;
  const lines = await db.execute(sql`select * from event_booking_tickets where booking_id = ${bookingId} order by unit_price_paise desc`);
  expect(lines).toHaveLength(2);
});

it('rejects over-capacity tier with tier_sold_out', async () => {
  const res = await app.inject({ method: 'POST', url: `/v1/consumer/events/${eventId}/book`,
    headers: bearer('user'),
    payload: { lines: [{ tierId: cappedTierId, quantity: 999 }] } });
  expect(res.statusCode).toBe(409);
  expect(res.json().code).toBe('tier_sold_out');
});
```

- [ ] **Step 4: Typecheck + run API test suite**

Run: `cd apps/api && pnpm typecheck && pnpm test`
Expected: typecheck PASS; full suite green (integration skipped locally). The whole API now typechecks end-to-end.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/consumer.ts apps/api/src/routes/bookings.ts apps/api/src/routes/bookings.test.ts
git commit -m "feat(api): event book routes accept multi-tier lines"
```

---

## Phase 4 — Consumer web UI (`apps/consumer`)

### Task 11: Consumer API types & hooks for tiers/lines

**Files:**
- Modify: `apps/consumer/lib/api/types.ts`
- Modify: `apps/consumer/lib/api/consumer.ts`
- Modify: `apps/consumer/lib/api/checkout.ts`

- [ ] **Step 1: Add `PublicTier` and put `tiers` on the event types**

In `types.ts`, add:

```ts
export interface PublicTier {
  id: string;
  name: string;
  description: string | null;
  pricePaise: number;
  capacity: number | null;
  remaining: number | null;
}
```

Add `tiers: PublicTier[];` to `PublicEvent` and (it inherits, but verify) `PublicEventWithVenue`. For the list type if separate, `tiers` may be `[]`.

- [ ] **Step 2: `BookEventInput.lines`**

In `consumer.ts`:

```ts
export interface BookEventInput {
  eventId: string;
  name?: string;
  contact?: string;
  couponCode?: string;
  lines: { tierId: string; quantity: number }[];
}
```

`useBookEvent` already spreads `...body` into the request body, so `lines` is sent automatically.

- [ ] **Step 3: Quote item lines**

In `checkout.ts`:

```ts
export type QuoteItem =
  | { itemType: 'event'; eventId: string; lines: { tierId: string; quantity: number }[] }
  | { itemType: 'membership'; membershipId: string }
  | { itemType: 'slot'; slotIds: string[] };
```

- [ ] **Step 4: Typecheck**

Run: `cd apps/consumer && pnpm typecheck`
Expected: FAIL where `CheckoutModal.tsx` / event page build the event quote/book without `lines` — fixed in Tasks 12–13. Proceed to those before re-checking.

- [ ] **Step 5: Commit**

```bash
git add apps/consumer/lib/api/types.ts apps/consumer/lib/api/consumer.ts apps/consumer/lib/api/checkout.ts
git commit -m "feat(consumer): tier + line types for events"
```

---

### Task 12: Event detail — tier selector, subtotal, CTA

**Files:**
- Modify: `apps/consumer/app/events/[id]/page.tsx`
- Modify: `apps/consumer/lib/checkout/types.ts`

- [ ] **Step 1: Carry lines on the event `CheckoutItem`**

In `lib/checkout/types.ts`:

```ts
export type CheckoutLine = { tierId: string; tierName: string; quantity: number; unitPricePaise: number };

export type CheckoutItem =
  | { kind: 'slot'; slotIds: string[]; title: string }
  | { kind: 'event'; eventId: string; title: string; lines: CheckoutLine[] }
  | { kind: 'membership'; membershipId: string; title: string };
```

- [ ] **Step 2: Render the tier selector on the event page**

In `app/events/[id]/page.tsx`, replace the single price + single "Book" button with a per-tier quantity selector. Add state and a derived subtotal, and open checkout with the selected lines. Core block (adapt to the page's existing layout/components — `formatPaiseExact`, the checkout opener from `useCheckout()`/`openCheckout`, and the `event.tiers` array):

```tsx
const [qty, setQty] = useState<Record<string, number>>({});
const tiers = event?.tiers ?? [];
const lines = tiers
  .filter((t) => (qty[t.id] ?? 0) > 0)
  .map((t) => ({ tierId: t.id, tierName: t.name, quantity: qty[t.id]!, unitPricePaise: t.pricePaise }));
const subtotalPaise = lines.reduce((s, l) => s + l.unitPricePaise * l.quantity, 0);
const totalSelected = lines.reduce((s, l) => s + l.quantity, 0);

function setTierQty(tierId: string, next: number, remaining: number | null) {
  const capped = remaining == null ? Math.max(0, next) : Math.min(Math.max(0, next), remaining);
  setQty((q) => ({ ...q, [tierId]: capped }));
}

// …in JSX, replace the price/Book section:
<div className="flex flex-col gap-3">
  {tiers.map((t) => {
    const soldOut = t.remaining != null && t.remaining <= 0;
    const n = qty[t.id] ?? 0;
    return (
      <div key={t.id} className="flex items-center justify-between rounded-[var(--radius)] border border-[var(--color-border)] px-4 py-3">
        <div>
          <div className="font-medium text-[var(--color-ink)]">{t.name}</div>
          {t.description && <div className="text-sm text-[var(--color-text-secondary)]">{t.description}</div>}
          <div className="text-sm">{t.pricePaise === 0 ? 'Free' : formatPaiseExact(t.pricePaise)}</div>
        </div>
        {soldOut ? (
          <span className="text-sm text-[var(--color-text-secondary)]">Sold out</span>
        ) : (
          <div className="flex items-center gap-2">
            <button type="button" aria-label={`Remove one ${t.name}`} onClick={() => setTierQty(t.id, n - 1, t.remaining)} disabled={n <= 0}>−</button>
            <span className="w-6 text-center">{n}</span>
            <button type="button" aria-label={`Add one ${t.name}`} onClick={() => setTierQty(t.id, n + 1, t.remaining)} disabled={t.remaining != null && n >= t.remaining}>+</button>
          </div>
        )}
      </div>
    );
  })}

  <div className="flex items-center justify-between border-t border-[var(--color-border)] pt-3">
    <span className="text-sm text-[var(--color-text-secondary)]">Subtotal</span>
    <span className="font-semibold">{formatPaiseExact(subtotalPaise)}</span>
  </div>

  <Button
    disabled={totalSelected === 0}
    onClick={() => openCheckout(
      { kind: 'event', eventId: event!.id, title: event!.name, lines },
      { /* prefill as today */ },
    )}
  >
    {subtotalPaise === 0 ? 'Register' : `Book · ${formatPaiseExact(subtotalPaise)}`}
  </Button>
</div>
```

Use the page's existing `Button` import and checkout opener; match its current prefill argument shape (read the existing `openCheckout` call before replacing).

- [ ] **Step 3: Typecheck + lint**

Run: `cd apps/consumer && pnpm typecheck`
Expected: PASS (after Task 13 the modal also compiles). If `useState` isn't imported on the page, add it.

- [ ] **Step 4: Commit**

```bash
git add apps/consumer/app/events/[id]/page.tsx apps/consumer/lib/checkout/types.ts
git commit -m "feat(consumer): per-tier quantity selector on event detail"
```

---

### Task 13: CheckoutModal — pass lines, show per-tier rows

**Files:**
- Modify: `apps/consumer/lib/checkout/CheckoutModal.tsx`

- [ ] **Step 1: Build quote + book with lines**

In `CheckoutModal.tsx`, update `quoteItem`:

```ts
function quoteItem(item: CheckoutItem): QuoteRequest {
  switch (item.kind) {
    case 'slot': return { itemType: 'slot', slotIds: item.slotIds };
    case 'event': return { itemType: 'event', eventId: item.eventId, lines: item.lines.map((l) => ({ tierId: l.tierId, quantity: l.quantity })) };
    case 'membership': return { itemType: 'membership', membershipId: item.membershipId };
  }
}
```

In `onPay`, the `item.kind === 'event'` branch passes `lines`:

```ts
const r = await bookEvent.mutateAsync({
  eventId: item.eventId,
  lines: item.lines.map((l) => ({ tierId: l.tierId, quantity: l.quantity })),
  ...(prefill.name ? { name: prefill.name } : {}),
  ...(prefill.contact ? { contact: prefill.contact } : {}),
  ...(appliedCode ? { couponCode: appliedCode } : {}),
});
```

- [ ] **Step 2: Render per-tier line items above the price rows**

Just before the `Base price` `<Row>`, add (only for events):

```tsx
{item.kind === 'event' && item.lines.map((l) => (
  <Row key={l.tierId} label={`${l.tierName} × ${l.quantity}`} value={formatPaiseExact(l.unitPricePaise * l.quantity)} muted />
))}
```

- [ ] **Step 3: Surface the `tier_sold_out` error nicely**

The catch in `onPay` already sets `{ kind: 'error', message }`. If the API message for `tier_sold_out` is terse, map it: where errors are shown, if `(e as Error).message` includes `sold out`, display "A ticket tier just sold out — go back and adjust quantities." (Optional polish; keep the generic path if simpler.)

- [ ] **Step 4: Typecheck + build the consumer app**

Run: `cd apps/consumer && pnpm typecheck && pnpm build`
Expected: PASS. (`pnpm build` catches Next.js route/type issues the dev server would.)

- [ ] **Step 5: Commit**

```bash
git add apps/consumer/lib/checkout/CheckoutModal.tsx
git commit -m "feat(consumer): checkout passes tier lines and shows per-tier rows"
```

---

## Phase 5 — Partner UI (`apps/partners`)

### Task 14: Tiers editor component + wire into the 4 event forms

**Files:**
- Create: `apps/partners/app/(protected)/_components/TiersEditor.tsx` (or the repo's shared components location — check where existing form components live first, e.g. `apps/partners/components/` or `apps/partners/lib/ui`).
- Modify: `apps/partners/app/(protected)/events/new/page.tsx`
- Modify: `apps/partners/app/(protected)/events/[eventId]/page.tsx`
- Modify: `apps/partners/app/(protected)/venues/[venueId]/events/new/page.tsx`
- Modify: `apps/partners/app/(protected)/venues/[venueId]/events/[eventId]/page.tsx`
- Modify: the partner events API hook/types (find with `grep -rn "useCreateEvent\|useCreateTenantEvent\|useUpdateEvent" apps/partners`).

- [ ] **Step 1: Build the editor component**

```tsx
'use client';
import { useState } from 'react';

export interface TierDraft {
  name: string;
  description?: string;
  priceRupees: string; // form input; convert to paise on submit
  capacity?: string;   // blank = unlimited
}

export function emptyTier(): TierDraft {
  return { name: '', description: '', priceRupees: '0', capacity: '' };
}

export function tiersToPayload(tiers: TierDraft[]) {
  return tiers.map((t) => ({
    name: t.name.trim(),
    description: t.description?.trim() || undefined,
    pricePaise: Math.round(parseFloat(t.priceRupees || '0') * 100),
    capacity: t.capacity?.trim() ? parseInt(t.capacity, 10) : null,
  }));
}

export function TiersEditor({ value, onChange, disabled }: {
  value: TierDraft[];
  onChange: (next: TierDraft[]) => void;
  disabled?: boolean;
}) {
  function update(i: number, patch: Partial<TierDraft>) {
    onChange(value.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="text-sm font-medium">Ticket tiers</div>
      {value.map((t, i) => (
        <div key={i} className="grid grid-cols-12 gap-2 rounded border p-3">
          <input className="col-span-4 rounded border px-2 py-1" placeholder="Tier name (e.g. VIP)" value={t.name} disabled={disabled} onChange={(e) => update(i, { name: e.target.value })} />
          <input className="col-span-3 rounded border px-2 py-1" placeholder="Price ₹" inputMode="decimal" value={t.priceRupees} disabled={disabled} onChange={(e) => update(i, { priceRupees: e.target.value })} />
          <input className="col-span-3 rounded border px-2 py-1" placeholder="Capacity (blank = ∞)" inputMode="numeric" value={t.capacity ?? ''} disabled={disabled} onChange={(e) => update(i, { capacity: e.target.value })} />
          <button type="button" className="col-span-2 text-sm text-red-600" disabled={disabled || value.length <= 1} onClick={() => onChange(value.filter((_, j) => j !== i))}>Remove</button>
          <input className="col-span-12 rounded border px-2 py-1" placeholder="Description (optional)" value={t.description ?? ''} disabled={disabled} onChange={(e) => update(i, { description: e.target.value })} />
        </div>
      ))}
      <button type="button" className="self-start text-sm font-medium underline" disabled={disabled} onClick={() => onChange([...value, emptyTier()])}>+ Add tier</button>
    </div>
  );
}
```

- [ ] **Step 2: Wire into the org "new event" form**

In `events/new/page.tsx`: remove the single `priceRupees`/`capacity` inputs and their state; add `const [tiers, setTiers] = useState<TierDraft[]>([emptyTier()]);`, render `<TiersEditor value={tiers} onChange={setTiers} />`, and in the submit handler send `tiers: tiersToPayload(tiers)` instead of `pricePaise`/`capacity`. Validate client-side: every tier needs a non-empty name; block submit if any name is blank.

- [ ] **Step 3: Wire into the other three forms identically**

Repeat Step 2 for `venues/[venueId]/events/new/page.tsx`, and for the two edit pages (`events/[eventId]/page.tsx`, `venues/[venueId]/events/[eventId]/page.tsx`). For the edit pages, initialise `tiers` state from the loaded event's `tiers` (map each tier to a `TierDraft`: `priceRupees: String(t.pricePaise / 100)`, `capacity: t.capacity == null ? '' : String(t.capacity)`), and disable the editor when the event is not `draft` (mirror how those pages already gate other fields).

- [ ] **Step 4: Update partner API hook input types**

In the partner events hook file, change the create/update payload types to include `tiers: { name; description?; pricePaise; capacity? }[]` and drop `pricePaise`/`capacity`. Ensure the partner event detail type exposes `tiers` for the edit-page initialisation.

- [ ] **Step 5: Typecheck + build partners**

Run: `cd apps/partners && pnpm typecheck && pnpm build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/partners
git commit -m "feat(partners): ticket tiers editor in event create/edit forms"
```

---

### Task 15: Registrations view — per-tier sold counts

**Files:**
- Modify: the partner event detail/registrations page (one or both of `events/[eventId]/page.tsx`, `venues/[venueId]/events/[eventId]/page.tsx`) and the API read it uses (`getEvent` already returns `tiers` with `sold`/`remaining` from Task 4).

- [ ] **Step 1: Show sold/remaining per tier**

On the partner event detail page where registrations are listed, render a small summary using `event.tiers`:

```tsx
<div className="flex flex-col gap-1 text-sm">
  {event.tiers.map((t) => (
    <div key={t.id} className="flex justify-between">
      <span>{t.name}</span>
      <span>{t.sold} sold{t.capacity != null ? ` / ${t.capacity}` : ''}</span>
    </div>
  ))}
</div>
```

- [ ] **Step 2: Typecheck + build**

Run: `cd apps/partners && pnpm typecheck && pnpm build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/partners
git commit -m "feat(partners): per-tier sold counts on event registrations"
```

---

## Phase 6 — Docs & final verification

### Task 16: Update the events help article

**Files:**
- Modify: `apps/partners/content/help/events.md`
- Check: `apps/partners/lib/help/articles.ts` (summary/metadata)
- Check: `apps/partners/content/help/README.md` (doc↔code map — confirm events is the right article)

- [ ] **Step 1: Document ticket tiers**

Add a section to `events.md` explaining: an event is sold as one or more ticket tiers; each tier has its own price and its own capacity (leave capacity blank for unlimited); attendees can buy multiple tickets across tiers in one checkout; tiers can be edited only while the event is a draft; per-tier sold counts appear on the event's registrations view. Keep the voice/format consistent with the rest of the file (read it first).

- [ ] **Step 2: Refresh metadata if the summary mentions pricing/capacity**

If the article's `summary` in `articles.ts` describes single-price events, update it to mention ticket tiers. No new article/slug is needed (this extends the existing events article).

- [ ] **Step 3: Commit**

```bash
git add apps/partners/content/help/events.md apps/partners/lib/help/articles.ts
git commit -m "docs(partners): document ticket tiers in events help article"
```

---

### Task 17: Full-repo verification

**Files:** none (verification only).

- [ ] **Step 1: Typecheck all three apps**

Run: `cd apps/api && pnpm typecheck` ; `cd apps/consumer && pnpm typecheck` ; `cd apps/partners && pnpm typecheck`
Expected: all PASS.

- [ ] **Step 2: Run API tests**

Run: `cd apps/api && pnpm test`
Expected: green (integration suites skipped without `RUN_INTEGRATION`). If a dev DB is available, run `RUN_INTEGRATION=1 DATABASE_URL=… pnpm test` and confirm the new tier/quote/booking tests pass.

- [ ] **Step 3: Build the frontends**

Run: `cd apps/consumer && pnpm build` ; `cd apps/partners && pnpm build`
Expected: both PASS.

- [ ] **Step 4: Re-read the migration against the schema**

Open `apps/api/src/db/migrations/00XX_ticket_tiers.sql` and confirm every column/type/FK matches the Drizzle schema from Task 1 (names, `bigint` for paise, `uuid` FKs, cascade on `event_id`/`booking_id`). Confirm the migration number is unique and is the highest.

- [ ] **Step 5: Final commit (if any verification fixes were needed)**

```bash
git add -A
git commit -m "chore: ticket tiers — verification fixes" || echo "nothing to commit"
```

---

## Self-Review (completed during planning)

- **Spec coverage:** tiers table (T1/T2), per-tier capacity (T6), per-event cart/multi-tier checkout (T9/T10/T12/T13), auto-migrate to default tier + legacy backfill (T2), `events.price_paise` = min tier (T3/T2), embedded draft-only replace-all editing (T3/T4/T8/T14), web-only consumer (Phase 4), partner forms ×4 + registrations (T14/T15), help docs same PR (T16), `tier_sold_out` error (T6/T13), free/paid mix → ₹0 skips Razorpay (unchanged path, exercised in T10). Flutter parity, global cart, per-tier coupons explicitly out of scope.
- **Placeholder scan:** migration number is intentionally `00XX` per repo's renumber-at-merge convention (T2 Step 1 resolves it); all code blocks are concrete.
- **Type consistency:** `TierInput`/`TierWithRemaining`/`EventLine`/`PublicTier`/`CheckoutLine` defined once and reused; `replaceTiers`/`listTiersWithRemaining`/`soldByTier` names consistent across tasks; `tier_sold_out` code consistent (T6 → T13).
- **Known coupling:** Tasks 4↔8 and 6↔7↔10 must land together for the API to typecheck (called out inline). Recommended commit/execution order is as numbered.
