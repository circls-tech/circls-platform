# Org-Scoped Events (Venue-less Events) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an organization (tenant) post events with no venue, supplying a standalone address+coords+timezone instead, mirroring the existing nullable-`venue_id` dual-scoping of memberships.

**Architecture:** `events.venue_id` becomes nullable; venue-less events carry their own `address_json`/`lat`/`lng`/`tz_name` (a DB CHECK enforces exactly one scope). A new tenant-level create/list API sits alongside the existing per-venue routes. Consumers get a unified standalone `/events/[id]` page; the cross-venue list `LEFT JOIN`s venues. Partners get top-level **Events** and **Memberships** sidebar tabs. Admin review already links events to tenants, so it needs only verification.

**Tech Stack:** Fastify + Drizzle (Postgres) API with `vitest` integration tests (`RUN_INTEGRATION`); Next.js App Router frontends (consumer, partners, admin) with `@tanstack/react-query`, verified via `tsc --noEmit`.

> **⚠️ Migration numbering (parallel agents):** This plan uses a **tentative** `0017_events_org_scoped`. Multiple branches develop in parallel and the worktree branched before main's `0016_user_interests`. **At merge time:** rebase onto latest `main`, then renumber the migration file + its `meta/_journal.json` entry to the true next number after main's highest, with a `when` timestamp greater than the prior entry. Do NOT treat `0017` as final.

> **Phasing:** Phase 1 (schema + API) must land first. Phases 2–5 are independent of each other afterward and may be parallelized. Each task is TDD where the API is involved; frontend tasks verify with typecheck + a manual browser check (no FE component-test harness exists).

> **Test command:** API integration tests run with `RUN_INTEGRATION=1 pnpm --filter @circls/api test`. A local Postgres with migrations applied (`pnpm --filter @circls/api db:migrate`) must be reachable via `DATABASE_URL`.

---

## Phase 1 — Schema + API core

### Task 1: Migration + Drizzle schema for nullable venue + standalone location

**Files:**
- Create: `apps/api/src/db/migrations/0017_events_org_scoped.sql`
- Modify: `apps/api/src/db/migrations/meta/_journal.json`
- Modify: `apps/api/src/db/schema/events.ts`

- [ ] **Step 1: Write the migration SQL**

Create `apps/api/src/db/migrations/0017_events_org_scoped.sql`:

```sql
-- Org-scoped (venue-less) events. venue_id becomes nullable; a venue-less event
-- carries its own address/coords/tz (parity with venues). Exactly-one-scope is
-- enforced by a CHECK: venue events keep location columns NULL (location is read
-- from the venue); standalone events require address_json + tz_name.
ALTER TABLE "events" ALTER COLUMN "venue_id" DROP NOT NULL;
ALTER TABLE "events" ADD COLUMN "address_json" jsonb;
ALTER TABLE "events" ADD COLUMN "lat" double precision;
ALTER TABLE "events" ADD COLUMN "lng" double precision;
ALTER TABLE "events" ADD COLUMN "tz_name" text;

ALTER TABLE "events" ADD CONSTRAINT "events_scope_chk" CHECK (
  (venue_id IS NOT NULL
     AND address_json IS NULL AND lat IS NULL AND lng IS NULL AND tz_name IS NULL)
  OR
  (venue_id IS NULL
     AND address_json IS NOT NULL AND tz_name IS NOT NULL)
);
```

- [ ] **Step 2: Register the migration in the journal**

In `apps/api/src/db/migrations/meta/_journal.json`, append a new entry to the `entries` array after the `0015_events_venue_scoped` entry (tentative idx — see merge note at top):

```json
    ,
    {
      "idx": 17,
      "version": "7",
      "when": 1780400000000,
      "tag": "0017_events_org_scoped",
      "breakpoints": true
    }
```

(Insert it inside the `entries` array, before the closing `]`. Keep the existing comma-formatting style used by the surrounding entries.)

- [ ] **Step 3: Update the Drizzle schema**

In `apps/api/src/db/schema/events.ts`, update the imports and the `events` table. Replace the import line:

```ts
import { integer, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
```

with:

```ts
import {
  doublePrecision,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
```

Replace the `venueId` field and add the location columns. Change:

```ts
  venueId: uuid('venue_id')
    .notNull()
    .references(() => venues.id),
  name: text('name').notNull(),
```

to:

```ts
  /** Null = org-scoped (venue-less). Mirrors memberships' nullable venue_id. */
  venueId: uuid('venue_id').references(() => venues.id),
  // Standalone-event location (set only when venueId is null; venue events read
  // their location from the venue). DB CHECK `events_scope_chk` enforces this.
  addressJson: jsonb('address_json').$type<Record<string, unknown>>(),
  lat: doublePrecision('lat'),
  lng: doublePrecision('lng'),
  tzName: text('tz_name'),
  name: text('name').notNull(),
```

- [ ] **Step 4: Apply the migration and verify it succeeds**

Run: `RUN_INTEGRATION=1 pnpm --filter @circls/api db:migrate`
Expected: logs `migrations_applied` and exits 0. Verify the constraint exists:
Run: `psql "$DATABASE_URL" -c "\d events"`
Expected: `venue_id` shown without `not null`; columns `address_json`, `lat`, `lng`, `tz_name` present; a CHECK constraint `events_scope_chk` listed.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/migrations/0017_events_org_scoped.sql apps/api/src/db/migrations/meta/_journal.json apps/api/src/db/schema/events.ts
git commit -m "feat(api): events schema — nullable venue + standalone location (0017)"
```

---

### Task 2: events_service — accept org scope + standalone location, list-by-tenant

**Files:**
- Modify: `apps/api/src/services/events_service.ts`
- Test: `apps/api/src/services/events_service.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/events_service.test.ts`:

```ts
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db, pingDb } from '../db/client.js';
import { tenants, users, venues } from '../db/schema/index.js';
import { createEvent, listEventsForTenant } from './events_service.js';

const runIntegration = Boolean(process.env.RUN_INTEGRATION);

describe.skipIf(!runIntegration)('events_service — scoping', () => {
  let tenantId: string;
  let venueId: string;
  let actorUserId: string;
  const ctx = () => ({ tenantId, actorUserId });

  beforeAll(async () => {
    await pingDb();
    const [u] = await db
      .insert(users)
      .values({ firebaseUid: `evtsvc-${Date.now()}`, email: `evt-${Date.now()}@test.x` })
      .returning();
    actorUserId = u!.id;
    const [t] = await db
      .insert(tenants)
      .values({ name: 'EvtSvc', slug: `evtsvc-${Date.now()}` })
      .returning();
    tenantId = t!.id;
    const [v] = await db
      .insert(venues)
      .values({ tenantId, name: 'EvtSvc Venue', status: 'active' })
      .returning();
    venueId = v!.id;
  });

  afterAll(async () => {
    await db.execute(sql`delete from audit_log where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from events where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from venues where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
    await db.execute(sql`delete from users where id = ${actorUserId}`);
    await closeDb();
  });

  it('creates a venue-scoped event with null location columns', async () => {
    const ev = await createEvent(ctx(), {
      tenantId,
      venueId,
      name: 'Venue Event',
      startsAt: new Date('2030-01-01T10:00:00Z'),
      endsAt: new Date('2030-01-01T12:00:00Z'),
      pricePaise: 0,
    });
    expect(ev.venueId).toBe(venueId);
    expect(ev.addressJson).toBeNull();
    expect(ev.tzName).toBeNull();
  });

  it('creates an org-scoped event with a standalone address + tz', async () => {
    const ev = await createEvent(ctx(), {
      tenantId,
      addressJson: { line1: '1 Park Rd', city: 'Pune' },
      lat: 18.52,
      lng: 73.85,
      tzName: 'Asia/Kolkata',
      name: 'Org Event',
      startsAt: new Date('2030-02-01T10:00:00Z'),
      endsAt: new Date('2030-02-01T12:00:00Z'),
      pricePaise: 0,
    });
    expect(ev.venueId).toBeNull();
    expect(ev.tzName).toBe('Asia/Kolkata');
    expect((ev.addressJson as Record<string, unknown>).city).toBe('Pune');
  });

  it('rejects a standalone event missing an address', async () => {
    await expect(
      createEvent(ctx(), {
        tenantId,
        tzName: 'Asia/Kolkata',
        name: 'No Address',
        startsAt: new Date('2030-03-01T10:00:00Z'),
        endsAt: new Date('2030-03-01T12:00:00Z'),
        pricePaise: 0,
      }),
    ).rejects.toThrow();
  });

  it('lists all events for the tenant (venue + standalone)', async () => {
    const rows = await listEventsForTenant(tenantId);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.some((r) => r.venueId === venueId)).toBe(true);
    expect(rows.some((r) => r.venueId === null)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `RUN_INTEGRATION=1 pnpm --filter @circls/api test -- events_service`
Expected: FAIL — `listEventsForTenant` is not exported / `createEvent` rejects the standalone payload type.

- [ ] **Step 3: Implement the service changes**

In `apps/api/src/services/events_service.ts`, replace the `CreateEventInput` interface and `createEvent` function with:

```ts
export interface CreateEventInput {
  tenantId: string;
  /** Omit for an org-scoped (venue-less) event. */
  venueId?: string | undefined;
  /** Standalone location — required when venueId is omitted. */
  addressJson?: Record<string, unknown> | undefined;
  lat?: number | undefined;
  lng?: number | undefined;
  tzName?: string | undefined;
  name: string;
  description?: string | undefined;
  startsAt: Date;
  endsAt: Date;
  pricePaise: number;
  capacity?: number | undefined;
}

/**
 * Create a draft Event. Venue-scoped when `venueId` is given (location read from
 * the venue); org-scoped when omitted, in which case `addressJson` + `tzName`
 * are required and stored on the event. Validates startsAt < endsAt.
 */
export async function createEvent(ctx: AuditCtx, input: CreateEventInput): Promise<Event> {
  if (input.startsAt >= input.endsAt) {
    throw new BadRequest('startsAt must be before endsAt', 'invalid_event_window');
  }
  const isStandalone = !input.venueId;
  if (isStandalone) {
    if (!input.addressJson) {
      throw new BadRequest('Org-scoped events require an address', 'event_address_required');
    }
    if (!input.tzName) {
      throw new BadRequest('Org-scoped events require a timezone', 'event_tz_required');
    }
  }

  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(events)
      .values({
        tenantId: input.tenantId,
        venueId: input.venueId ?? null,
        addressJson: isStandalone ? (input.addressJson ?? null) : null,
        lat: isStandalone ? (input.lat ?? null) : null,
        lng: isStandalone ? (input.lng ?? null) : null,
        tzName: isStandalone ? (input.tzName ?? null) : null,
        name: input.name,
        description: input.description ?? null,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        pricePaise: input.pricePaise,
        capacity: input.capacity ?? null,
        status: 'draft',
      })
      .returning();
    if (!row) throw new Error('event insert returned no row');

    await writeAudit(tx, ctx, 'event.created', 'event', row.id, null, {
      venueId: row.venueId,
      isStandalone,
      name: row.name,
      pricePaise: row.pricePaise,
    });

    return row;
  });
}
```

Then add a tenant-wide list function next to `listEventsForVenue`:

```ts
/** All events for a tenant (venue-scoped + org-scoped), newest first. */
export async function listEventsForTenant(tenantId: string): Promise<Event[]> {
  return db
    .select()
    .from(events)
    .where(eq(events.tenantId, tenantId))
    .orderBy(sql`${events.createdAt} desc`);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `RUN_INTEGRATION=1 pnpm --filter @circls/api test -- events_service`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/events_service.ts apps/api/src/services/events_service.test.ts
git commit -m "feat(api): events_service supports org scope + listEventsForTenant"
```

---

### Task 3: Tenant-level event routes (create + list)

**Files:**
- Modify: `apps/api/src/routes/events.ts`
- Test: `apps/api/src/routes/events.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/events.test.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      owner: { uid: 'fbuid_evt_owner', email: 'evtowner@x.com' },
    };
    const u = map[token];
    if (!u) throw new Error('bad token');
    return u;
  }),
}));

const { closeDb, db } = await import('../db/client.js');
const { buildServer } = await import('../server.js');

const runIntegration = Boolean(process.env.RUN_INTEGRATION);
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

describe.skipIf(!runIntegration)('tenant event routes', () => {
  let app: FastifyInstance;
  let ownerId: string;
  let tenantId: string;
  const SUFFIX = Date.now();

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer('owner') });
    ownerId = (me.json() as { id: string }).id;
    const t = await app.inject({
      method: 'POST',
      url: '/v1/tenants',
      headers: bearer('owner'),
      payload: { name: 'EvtRoutes', slug: `evtroutes-${SUFFIX}` },
    });
    tenantId = (t.json() as { id: string }).id;
  });

  afterAll(async () => {
    await db.execute(sql`delete from audit_log where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from events where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenant_members where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
    await db.execute(sql`delete from users where id = ${ownerId}`);
    await app.close();
    await closeDb();
  });

  it('creates an org-scoped event via POST /v1/tenants/:tenantId/events', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/events`,
      headers: bearer('owner'),
      payload: {
        addressJson: { line1: '5 MG Rd', city: 'Pune' },
        tzName: 'Asia/Kolkata',
        name: 'Standalone Meetup',
        startsAt: '2030-05-01T10:00:00.000Z',
        endsAt: '2030-05-01T12:00:00.000Z',
        pricePaise: 0,
      },
    });
    expect(res.statusCode).toBe(200);
    const ev = res.json();
    expect(ev.venueId).toBeNull();
    expect(ev.tzName).toBe('Asia/Kolkata');
  });

  it('rejects a payload with both venueId and addressJson', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/events`,
      headers: bearer('owner'),
      payload: {
        venueId: '00000000-0000-0000-0000-000000000000',
        addressJson: { line1: 'x' },
        tzName: 'Asia/Kolkata',
        name: 'Both',
        startsAt: '2030-05-01T10:00:00.000Z',
        endsAt: '2030-05-01T12:00:00.000Z',
        pricePaise: 0,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('lists tenant events via GET /v1/tenants/:tenantId/events', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/events`,
      headers: bearer('owner'),
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json();
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.some((r: { venueId: string | null }) => r.venueId === null)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `RUN_INTEGRATION=1 pnpm --filter @circls/api test -- routes/events`
Expected: FAIL — `POST /v1/tenants/:tenantId/events` returns 404 (route not found).

- [ ] **Step 3: Implement the routes**

In `apps/api/src/routes/events.ts`, add `listEventsForTenant` to the service import block:

```ts
import {
  cancelEvent,
  createEvent,
  getEvent,
  listEventBookings,
  listEventsForTenant,
  listEventsForVenue,
  publishEvent,
  updateEvent,
} from '../services/events_service.js';
```

Add a Zod schema for the tenant-level create after `createEventSchema`:

```ts
const createTenantEventSchema = z
  .object({
    venueId: z.string().uuid().optional(),
    addressJson: z.record(z.unknown()).optional(),
    lat: z.number().optional(),
    lng: z.number().optional(),
    tzName: z.string().min(1).optional(),
    name: z.string().min(1).max(200),
    description: z.string().optional(),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
    pricePaise: z.number().int().min(0),
    capacity: z.number().int().min(1).optional(),
  })
  // Exactly one scope: a venue OR a standalone address (never both, never neither).
  .refine((d) => Boolean(d.venueId) !== Boolean(d.addressJson), {
    message: 'Provide exactly one of venueId or addressJson',
  })
  .refine((d) => Boolean(d.venueId) || Boolean(d.tzName), {
    message: 'Standalone events require tzName',
  });
```

Inside the `eventRoutes` plugin, add a tenant-scoped list and create (place them after the existing `GET /v1/tenants/:tenantId/events/:id` handler):

```ts
  app.get('/v1/tenants/:tenantId/events', { preHandler: requireAuth }, async (req) => {
    const { tenantId } = req.params as { tenantId: string };
    const user = await currentUser(req);
    await requireTenantMembership(user.id, tenantId);
    return listEventsForTenant(tenantId);
  });

  app.post('/v1/tenants/:tenantId/events', { preHandler: requireAuth }, async (req) => {
    const { tenantId } = req.params as { tenantId: string };
    const user = await currentUser(req);
    await requireTenantMembership(user.id, tenantId);
    const parsed = createTenantEventSchema.safeParse(req.body);
    if (!parsed.success)
      throw new BadRequest('Invalid event payload', 'bad_request', {
        issues: parsed.error.issues,
      });

    // Venue-scoped: the venue must belong to this tenant.
    if (parsed.data.venueId) {
      const venue = await getVenueById(parsed.data.venueId);
      if (!venue || venue.tenantId !== tenantId)
        throw new NotFound('Venue not found', 'venue_not_found');
    }

    return createEvent(
      { tenantId, actorUserId: user.id },
      {
        tenantId,
        venueId: parsed.data.venueId,
        addressJson: parsed.data.addressJson,
        lat: parsed.data.lat,
        lng: parsed.data.lng,
        tzName: parsed.data.tzName,
        name: parsed.data.name,
        description: parsed.data.description,
        startsAt: new Date(parsed.data.startsAt),
        endsAt: new Date(parsed.data.endsAt),
        pricePaise: parsed.data.pricePaise,
        capacity: parsed.data.capacity,
      },
    );
  });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `RUN_INTEGRATION=1 pnpm --filter @circls/api test -- routes/events`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/events.ts apps/api/src/routes/events.test.ts
git commit -m "feat(api): tenant-level event create + list routes (org-scoped)"
```

---

## Phase 2 — Consumer API + UI

### Task 4: Consumer service — effective location + standalone event read

**Files:**
- Modify: `apps/api/src/services/consumer_service.ts`
- Test: `apps/api/src/services/consumer_events.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/consumer_events.test.ts`:

```ts
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db, pingDb } from '../db/client.js';
import { events, tenants } from '../db/schema/index.js';
import { getPublicEventById, listPublicUpcomingEvents } from './consumer_service.js';

const runIntegration = Boolean(process.env.RUN_INTEGRATION);

describe.skipIf(!runIntegration)('consumer org-scoped events', () => {
  let tenantId: string;
  let eventId: string;

  beforeAll(async () => {
    await pingDb();
    const [t] = await db
      .insert(tenants)
      .values({ name: 'ConsumerOrg', slug: `consorg-${Date.now()}`, status: 'active' })
      .returning();
    tenantId = t!.id;
    const [e] = await db
      .insert(events)
      .values({
        tenantId,
        venueId: null,
        addressJson: { line1: '9 Hill Rd', city: 'Pune' },
        tzName: 'Asia/Kolkata',
        name: 'Public Org Event',
        startsAt: new Date('2030-09-01T10:00:00Z'),
        endsAt: new Date('2030-09-01T12:00:00Z'),
        pricePaise: 0,
        status: 'published',
      })
      .returning();
    eventId = e!.id;
  });

  afterAll(async () => {
    await db.execute(sql`delete from events where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
    await closeDb();
  });

  it('surfaces a venue-less published event in the cross-venue list', async () => {
    const rows = await listPublicUpcomingEvents({ limit: 100 });
    const row = rows.find((r) => r.id === eventId);
    expect(row).toBeTruthy();
    expect(row!.isStandalone).toBe(true);
    expect(row!.venueName).toBeNull();
    expect(row!.locationName).toBe('ConsumerOrg');
    expect(row!.locTzName).toBe('Asia/Kolkata');
  });

  it('fetches a single standalone event by id with resolved location', async () => {
    const row = await getPublicEventById(eventId);
    expect(row).toBeTruthy();
    expect(row!.isStandalone).toBe(true);
    expect((row!.locAddressJson as Record<string, unknown>).city).toBe('Pune');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `RUN_INTEGRATION=1 pnpm --filter @circls/api test -- consumer_events`
Expected: FAIL — `getPublicEventById` not exported; `listPublicUpcomingEvents` rows lack `isStandalone`/`locationName`.

- [ ] **Step 3: Implement the service changes**

In `apps/api/src/services/consumer_service.ts`, replace the `PublicEventWithVenue` interface and `listPublicUpcomingEvents` function, and add a shared mapper + `getPublicEventById`. Replace this block:

```ts
/** A public event enriched with its owning venue's name + tags (for cross-venue cards). */
export interface PublicEventWithVenue extends Event {
  venueName: string;
  venueTags: string[];
}
```

with:

```ts
/**
 * A public event with a resolved ("effective") location: a venue event reads
 * its location from the venue; a standalone (venue-less) event uses its own
 * columns and the tenant/org name. `loc*` fields are what the UI renders.
 */
export interface PublicEventWithVenue extends Event {
  venueName: string | null;
  venueTags: string[];
  isStandalone: boolean;
  locationName: string;
  locLat: number | null;
  locLng: number | null;
  locTzName: string;
  locAddressJson: Record<string, unknown> | null;
}

interface EventJoinRow {
  e: Event;
  venueName: string | null;
  venueTags: string[] | null;
  venueLat: number | null;
  venueLng: number | null;
  venueTz: string | null;
  venueAddr: Record<string, unknown> | null;
  tenantName: string;
}

function toPublicEvent(r: EventJoinRow): PublicEventWithVenue {
  const isStandalone = r.e.venueId === null;
  return {
    ...r.e,
    venueName: r.venueName,
    venueTags: r.venueTags ?? [],
    isStandalone,
    locationName: r.venueName ?? r.tenantName,
    locLat: isStandalone ? r.e.lat : r.venueLat,
    locLng: isStandalone ? r.e.lng : r.venueLng,
    locTzName: (isStandalone ? r.e.tzName : r.venueTz) ?? 'Asia/Kolkata',
    locAddressJson: isStandalone ? (r.e.addressJson ?? null) : r.venueAddr,
  };
}

const PUBLIC_EVENT_COLUMNS = {
  e: events,
  venueName: venues.name,
  venueTags: venues.tags,
  venueLat: venues.lat,
  venueLng: venues.lng,
  venueTz: venues.tzName,
  venueAddr: venues.addressJson,
  tenantName: tenants.name,
} as const;
```

Replace `listPublicUpcomingEvents` with:

```ts
/**
 * All published, upcoming events across every visible tenant, soonest first.
 * Venue events require an active venue; org-scoped events have none. Each row
 * carries a resolved location (see toPublicEvent).
 */
export async function listPublicUpcomingEvents(opts: { limit?: number }): Promise<PublicEventWithVenue[]> {
  const limit = Math.min(opts.limit ?? 50, 100);
  const rows = await db
    .select(PUBLIC_EVENT_COLUMNS)
    .from(events)
    .leftJoin(venues, eq(venues.id, events.venueId))
    .innerJoin(tenants, eq(tenants.id, events.tenantId))
    .where(
      and(
        eq(events.status, 'published'),
        eq(tenants.status, 'active'),
        sql`(${events.venueId} is null or ${venues.status} = 'active')`,
        sql`${events.endsAt} >= now()`,
      ),
    )
    .orderBy(sql`${events.startsAt} asc`)
    .limit(limit);
  return (rows as EventJoinRow[]).map(toPublicEvent);
}

/** A single published, upcoming event (venue or standalone) by id, or null. */
export async function getPublicEventById(id: string): Promise<PublicEventWithVenue | null> {
  const [row] = await db
    .select(PUBLIC_EVENT_COLUMNS)
    .from(events)
    .leftJoin(venues, eq(venues.id, events.venueId))
    .innerJoin(tenants, eq(tenants.id, events.tenantId))
    .where(
      and(
        eq(events.id, id),
        eq(events.status, 'published'),
        eq(tenants.status, 'active'),
        sql`(${events.venueId} is null or ${venues.status} = 'active')`,
        sql`${events.endsAt} >= now()`,
      ),
    )
    .limit(1);
  return row ? toPublicEvent(row as EventJoinRow) : null;
}
```

> Note: `tenants` is already imported in this file (used by `listPublicUpcomingEvents`'s existing query). If a typecheck flags a missing import, add `tenants` to the existing `../db/schema/...` import.

- [ ] **Step 4: Run the test to verify it passes**

Run: `RUN_INTEGRATION=1 pnpm --filter @circls/api test -- consumer_events`
Expected: PASS (2 tests). Also run `pnpm --filter @circls/api typecheck` — expect no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/consumer_service.ts apps/api/src/services/consumer_events.test.ts
git commit -m "feat(api): consumer events resolve effective location; getPublicEventById"
```

---

### Task 5: Consumer route — GET /v1/consumer/events/:id

**Files:**
- Modify: `apps/api/src/routes/consumer.ts`
- Test: extend `apps/api/src/routes/events.test.ts` is API-internal; this endpoint is public so add a focused test in `apps/api/src/services/consumer_events.test.ts` is covered. Add a route-level smoke test inline below.

- [ ] **Step 1: Add the route**

In `apps/api/src/routes/consumer.ts`, add `getPublicEventById` to the service import block (alongside `listPublicUpcomingEvents`):

```ts
  getPublicEventById,
```

Add the handler near the existing `GET /v1/consumer/events` handler:

```ts
  app.get('/v1/consumer/events/:id', async (req) => {
    const { id } = req.params as { id: string };
    const ev = await getPublicEventById(id);
    if (!ev) throw new NotFound('Event not found', 'event_not_found');
    return ev;
  });
```

> Ensure `NotFound` is imported in this file (it is used elsewhere in consumer routes; if not, add `import { NotFound } from '../lib/errors.js';`).

- [ ] **Step 2: Verify with a manual request after migrate + seed**

Run: `RUN_INTEGRATION=1 pnpm --filter @circls/api test -- consumer_events`
Expected: still PASS (service tests cover the resolution). Then typecheck:
Run: `pnpm --filter @circls/api typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/routes/consumer.ts
git commit -m "feat(api): GET /v1/consumer/events/:id (public single event)"
```

---

### Task 6: Consumer FE — types + useEvent hook + EventCard re-link

**Files:**
- Modify: `apps/consumer/lib/api/types.ts`
- Modify: `apps/consumer/lib/api/consumer.ts`
- Modify: `apps/consumer/components/cards/EventCard.tsx`

- [ ] **Step 1: Extend the public-event type**

In `apps/consumer/lib/api/types.ts`, replace the `PublicEventWithVenue` interface:

```ts
/** An event plus its owning venue's name + tags (for the card image). */
export interface PublicEventWithVenue extends PublicEvent {
  venueName: string;
  venueTags: string[];
}
```

with:

```ts
/**
 * A public event with a resolved location. `venueId` is null for org-scoped
 * (venue-less) events; `locationName` is the venue name or the org name.
 */
export interface PublicEventWithVenue extends Omit<PublicEvent, 'venueId'> {
  venueId: string | null;
  venueName: string | null;
  venueTags: string[];
  isStandalone: boolean;
  locationName: string;
  locLat: number | null;
  locLng: number | null;
  locTzName: string;
  locAddressJson: Record<string, unknown> | null;
}
```

- [ ] **Step 2: Add the single-event hook**

In `apps/consumer/lib/api/consumer.ts`, add the `PublicEventWithVenue` import (it is already imported) and add this hook after `useUpcomingEvents`:

```ts
/** A single public event (venue or standalone) by id. */
export function useEvent(eventId: string) {
  return useQuery({
    queryKey: ['event', eventId],
    queryFn: () => apiFetch<PublicEventWithVenue>(`/v1/consumer/events/${eventId}`),
    enabled: Boolean(eventId),
  });
}
```

- [ ] **Step 3: Re-link EventCard to the standalone event page**

Replace `apps/consumer/components/cards/EventCard.tsx` with:

```tsx
import Link from 'next/link';
import { SportImage } from '@/components/SportImage';
import { formatDayMonth, formatTime, formatPaise } from '@/lib/format';
import type { PublicEventWithVenue } from '@/lib/api/types';

export function EventCard({ event, className = '' }: { event: PublicEventWithVenue; className?: string }) {
  const { day, month } = formatDayMonth(event.startsAt);
  return (
    <Link
      href={`/events/${event.id}`}
      className={`block overflow-hidden rounded-card border border-border bg-white transition-all hover:-translate-y-1 hover:shadow-[0_16px_36px_rgba(15,28,46,0.16)] ${className}`}
    >
      <div className="relative">
        <SportImage
          input={{ tags: event.venueTags }}
          alt={`${event.name} at ${event.locationName}`}
          className="h-[140px]"
        />
        <div className="absolute left-2.5 top-2.5 rounded-lg bg-white px-2.5 py-1 text-center leading-none shadow-md">
          <div className="font-display text-lg font-bold text-ink">{day}</div>
          <div className="text-[9px] font-bold uppercase tracking-widest text-gold-600">{month}</div>
        </div>
      </div>
      <div className="p-4">
        <h3 className="font-display text-[18px] font-semibold text-ink">{event.name}</h3>
        <p className="mt-0.5 text-sm text-text-secondary">
          {event.locationName} · {formatTime(event.startsAt)}
        </p>
        <p className="mt-2 text-sm font-semibold text-ink">{formatPaise(event.pricePaise)}</p>
      </div>
    </Link>
  );
}
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @circls/consumer typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/consumer/lib/api/types.ts apps/consumer/lib/api/consumer.ts apps/consumer/components/cards/EventCard.tsx
git commit -m "feat(consumer): event types + useEvent; EventCard links to /events/[id]"
```

---

### Task 7: Consumer — unified standalone /events/[id] page

**Files:**
- Create: `apps/consumer/app/events/[id]/page.tsx`

- [ ] **Step 1: Create the event detail + booking page**

Create `apps/consumer/app/events/[id]/page.tsx`:

```tsx
'use client';
import { use } from 'react';
import Link from 'next/link';
import { Header } from '@/components/Header';
import { SportImage } from '@/components/SportImage';
import { useEvent } from '@/lib/api/consumer';
import { useAuth } from '@/lib/firebase/auth_context';
import { formatDateTime, formatPaise } from '@/lib/format';
import { useCheckout, type CheckoutState } from '@/lib/useCheckout';
import { Badge, Button, Card } from '@/lib/ui';

function AddressLine({ addressJson }: { addressJson: Record<string, unknown> | null }) {
  if (!addressJson) return null;
  const parts = ['line1', 'line2', 'city', 'state', 'pincode']
    .map((k) => addressJson[k])
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
  if (parts.length === 0) return null;
  return <p className="mt-2 text-sm text-text-secondary">{parts.join(', ')}</p>;
}

function CheckoutBanner({ state, onDismiss }: { state: CheckoutState; onDismiss: () => void }) {
  if (state.kind === 'idle') return null;
  const tone =
    state.kind === 'success'
      ? 'bg-green-50 text-green-800 border-green-200'
      : state.kind === 'reserved'
        ? 'bg-amber-50 text-amber-800 border-amber-200'
        : 'bg-red-50 text-red-700 border-red-200';
  return (
    <div className={`mb-6 flex items-start justify-between gap-4 rounded-[var(--radius)] border px-4 py-3 text-sm ${tone}`}>
      <span>{state.message}</span>
      <button type="button" onClick={onDismiss} className="font-medium underline">
        Dismiss
      </button>
    </div>
  );
}

export default function EventPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const eventQ = useEvent(id);
  const checkout = useCheckout();
  const { user } = useAuth();
  const ev = eventQ.data;
  const isFree = (ev?.pricePaise ?? 0) === 0;
  const mapsHref =
    ev && ev.locLat != null && ev.locLng != null
      ? `https://www.google.com/maps/search/?api=1&query=${ev.locLat},${ev.locLng}`
      : null;

  return (
    <div className="min-h-screen">
      <Header />
      <main className="mx-auto max-w-3xl px-4 py-8">
        {eventQ.isLoading ? (
          <p className="text-sm text-text-secondary">Loading event…</p>
        ) : eventQ.isError ? (
          <p className="text-sm text-red-600">
            {eventQ.error instanceof Error ? eventQ.error.message : 'Failed to load event'}
          </p>
        ) : !ev ? (
          <p className="text-sm text-text-secondary">Event not found.</p>
        ) : (
          <>
            <div className="mb-6 overflow-hidden rounded-card border border-border">
              <SportImage input={{ tags: ev.venueTags }} alt={ev.name} className="h-44 sm:h-56" />
              <div className="bg-white p-5">
                <div className="flex items-center gap-2">
                  <h1 className="font-display text-3xl font-semibold text-ink">{ev.name}</h1>
                  {ev.isStandalone && <Badge tone="neutral" label="Event" />}
                </div>
                <p className="mt-1 text-sm text-text-secondary">{formatDateTime(ev.startsAt)}</p>
                <p className="mt-2 text-sm font-medium text-ink">{ev.locationName}</p>
                <AddressLine addressJson={ev.locAddressJson} />
                {mapsHref && (
                  <a href={mapsHref} target="_blank" rel="noreferrer" className="mt-1 inline-block text-sm text-gold-600 underline">
                    View on map
                  </a>
                )}
                {!ev.isStandalone && ev.venueId && (
                  <Link href={`/venues/${ev.venueId}`} className="mt-1 block text-sm text-gold-600 underline">
                    More at {ev.venueName}
                  </Link>
                )}
              </div>
            </div>

            <CheckoutBanner state={checkout.state} onDismiss={checkout.reset} />

            <Card className="flex flex-col gap-3">
              {ev.description && <p className="text-sm text-text-secondary">{ev.description}</p>}
              <div className="flex items-center gap-2 text-sm text-text-secondary">
                <span className="font-medium text-ink">{formatPaise(ev.pricePaise)}</span>
                {ev.capacity != null && <span>· {ev.capacity} seats</span>}
              </div>
              <div className="pt-2">
                <Button
                  loading={checkout.busy}
                  onClick={() => {
                    const prefill: { name?: string; contact?: string } = {};
                    if (user?.displayName) prefill.name = user.displayName;
                    if (user?.phoneNumber) prefill.contact = user.phoneNumber;
                    void checkout.bookEventNow(ev.id, ev.pricePaise, prefill);
                  }}
                >
                  {isFree ? 'Register' : 'Book'}
                </Button>
              </div>
            </Card>
          </>
        )}
      </main>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @circls/consumer typecheck`
Expected: no errors.

> If `Badge` does not accept a label-only call without `tone="sport"`, match the existing usage in `venues/[venueId]/page.tsx` (it uses `tone="sport"`/`tone="neutral"`). Adjust the `tone` prop to a value the `Badge` component supports.

- [ ] **Step 3: Manual verification**

Run the consumer app (`pnpm --filter @circls/consumer dev`), create a published org-scoped event via the API, then visit `/events/<id>`. Expected: page renders name, org name, address, map link, and a working Register/Book button. Also confirm an EventCard on `/events` links here.

- [ ] **Step 4: Commit**

```bash
git add apps/consumer/app/events/[id]/page.tsx
git commit -m "feat(consumer): unified /events/[id] detail + booking page"
```

---

## Phase 3 — Partners IA: Events + Memberships tabs

### Task 8: Promote Events + Memberships to top-level sidebar tabs

**Files:**
- Modify: `apps/partners/app/(protected)/layout.tsx`
- Create: `apps/partners/app/(protected)/memberships/page.tsx`
- Modify (relocate): `apps/partners/app/(protected)/settings/memberships/page.tsx`

- [ ] **Step 1: Add the nav links**

In `apps/partners/app/(protected)/layout.tsx`, replace the `NAV_LINKS` constant:

```ts
const NAV_LINKS = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/venues', label: 'Venues' },
  { href: '/events', label: 'Events' },
  { href: '/memberships', label: 'Memberships' },
  { href: '/settings', label: 'Settings' },
] as const;
```

- [ ] **Step 2: Relocate the memberships page out of Settings**

Move the existing memberships page to the new top-level route, preserving git history:

```bash
git mv "apps/partners/app/(protected)/settings/memberships/page.tsx" "apps/partners/app/(protected)/memberships/page.tsx"
```

If the page reads its route or links assume a `/settings/memberships` base, update any in-file `href`/redirect strings from `/settings/memberships` to `/memberships`. (Open the moved file and grep for `settings/memberships`; replace with `memberships`.)

- [ ] **Step 3: Add a redirect from the old Settings location**

Create `apps/partners/app/(protected)/settings/memberships/page.tsx`:

```tsx
import { redirect } from 'next/navigation';

// Memberships moved to a top-level tab. Keep this redirect for any bookmarks.
export default function SettingsMembershipsRedirect() {
  redirect('/memberships');
}
```

- [ ] **Step 4: Typecheck + manual nav check**

Run: `pnpm --filter @circls/partners typecheck`
Expected: no errors. Then run the partners app and confirm the sidebar shows Dashboard · Venues · Events · Memberships · Settings, and `/memberships` renders the membership UI.

- [ ] **Step 5: Commit**

```bash
git add "apps/partners/app/(protected)/layout.tsx" "apps/partners/app/(protected)/memberships/page.tsx" "apps/partners/app/(protected)/settings/memberships/page.tsx"
git commit -m "feat(partners): Events + Memberships top-level tabs; move memberships out of Settings"
```

---

## Phase 4 — Partners: tenant-level event create with scope toggle

### Task 9: Partners API — tenant event hooks + types

**Files:**
- Modify: `apps/partners/lib/api/events.ts`
- Modify: `apps/partners/lib/api/types.ts`

- [ ] **Step 1: Extend the VenueEvent type**

In `apps/partners/lib/api/types.ts`, find the `VenueEvent` interface and make `venueId` nullable and add the standalone location fields. Replace the `venueId` line (currently `venueId: string;`) with:

```ts
  venueId: string | null;
  addressJson: Record<string, unknown> | null;
  lat: number | null;
  lng: number | null;
  tzName: string | null;
```

- [ ] **Step 2: Add tenant-level list + create hooks**

In `apps/partners/lib/api/events.ts`, add after the existing `useVenueEvents` hook:

```ts
/** All events for a tenant (venue-scoped + org-scoped). */
export function useTenantEvents(tenantId: string) {
  return useQuery({
    queryKey: ['tenant-events', tenantId],
    queryFn: () => apiFetch<VenueEvent[]>(`/v1/tenants/${tenantId}/events`),
    enabled: Boolean(tenantId),
  });
}

export interface CreateTenantEventInput {
  /** Provide exactly one scope: a venueId OR a standalone address. */
  venueId?: string;
  addressJson?: Record<string, unknown>;
  lat?: number;
  lng?: number;
  tzName?: string;
  name: string;
  description?: string;
  /** ISO-8601, with tz. */
  startsAt: string;
  endsAt: string;
  pricePaise: number;
  capacity?: number;
}

export function useCreateTenantEvent(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTenantEventInput) =>
      apiFetch<VenueEvent>(`/v1/tenants/${tenantId}/events`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['tenant-events', tenantId] }),
  });
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @circls/partners typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/partners/lib/api/events.ts apps/partners/lib/api/types.ts
git commit -m "feat(partners): tenant event hooks (list + create) and nullable-venue type"
```

---

### Task 10: Partners — Events tab list page

**Files:**
- Create: `apps/partners/app/(protected)/events/page.tsx`

- [ ] **Step 1: Create the tenant events list page**

Create `apps/partners/app/(protected)/events/page.tsx`:

```tsx
'use client';
import Link from 'next/link';
import { useOrg } from '@/lib/org_context';
import { useTenantEvents } from '@/lib/api/events';
import { Badge, Button, Card, StatusPill } from '@/lib/ui';

const IST = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  dateStyle: 'medium',
  timeStyle: 'short',
});

function EventList({ tenantId }: { tenantId: string }) {
  const { data: events, isLoading } = useTenantEvents(tenantId);
  if (isLoading) return <p className="text-sm text-slate-500">Loading events…</p>;
  if (!events || events.length === 0) {
    return <p className="text-sm text-slate-500">No events yet for this organization.</p>;
  }
  return (
    <ul className="flex flex-col gap-3">
      {events.map((ev) => (
        <li
          key={ev.id}
          className="rounded-[var(--radius)] border border-[#e5e7eb] bg-white p-4 shadow-sm"
        >
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium text-[#0f172a]">{ev.name}</p>
              <p className="mt-0.5 text-xs text-slate-400">{IST.format(new Date(ev.startsAt))}</p>
            </div>
            <div className="flex items-center gap-2">
              <Badge tone="neutral" label={ev.venueId ? 'Venue' : 'Standalone'} />
              <StatusPill status={ev.status} />
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

export default function EventsPage() {
  const { activeTenantId, tenants } = useOrg();
  const activeTenant = tenants.find((t) => t.id === activeTenantId);

  if (!activeTenantId) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-xl font-semibold text-[#0f172a]">Events</h1>
        <Card subtitle="Select or create an organization first to view its events.">
          <p className="text-sm text-slate-500">
            No active organization. Use the switcher in the top bar to pick one.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-[#0f172a]">Events</h1>
          {activeTenant && <p className="mt-0.5 text-sm text-slate-500">{activeTenant.name}</p>}
        </div>
        <Link href="/events/new">
          <Button>Create event</Button>
        </Link>
      </div>
      <EventList tenantId={activeTenantId} />
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @circls/partners typecheck`
Expected: no errors.

> If `Button` cannot be a child of `Link` in this UI kit, swap to `<Link href="/events/new" className="...">Create event</Link>` styled like the existing buttons in `venues/[venueId]/events/new/page.tsx`.

- [ ] **Step 3: Commit**

```bash
git add "apps/partners/app/(protected)/events/page.tsx"
git commit -m "feat(partners): Events tab — list all org events with scope badge"
```

---

### Task 11: Partners — create-event page with venue/standalone scope toggle

**Files:**
- Create: `apps/partners/app/(protected)/events/new/page.tsx`

- [ ] **Step 1: Create the scope-toggle create form**

Create `apps/partners/app/(protected)/events/new/page.tsx`:

```tsx
'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { useOrg } from '@/lib/org_context';
import { useVenues } from '@/lib/api/queries';
import { useCreateTenantEvent, type CreateTenantEventInput } from '@/lib/api/events';
import { Button, Card, Input } from '@/lib/ui';

/** Re-interpret a datetime-local value in the given tz as a UTC ISO string. */
function localToTzIso(local: string, tz: string): string {
  if (!local) return '';
  const asIfUtc = new Date(`${local}:00Z`);
  const wall = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(asIfUtc);
  const [datePart, timePart] = wall.split(', ');
  const wallIso = `${datePart}T${timePart}Z`;
  const offsetMs = new Date(wallIso).getTime() - asIfUtc.getTime();
  return new Date(asIfUtc.getTime() - offsetMs).toISOString();
}

type Scope = 'venue' | 'standalone';

export default function NewTenantEventPage() {
  const router = useRouter();
  const { activeTenantId } = useOrg();
  const tenantId = activeTenantId ?? '';
  const { data: venues } = useVenues(tenantId);
  const createEvent = useCreateTenantEvent(tenantId);

  const [scope, setScope] = useState<Scope>('venue');
  const [venueId, setVenueId] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [startsAtLocal, setStartsAtLocal] = useState('');
  const [endsAtLocal, setEndsAtLocal] = useState('');
  const [priceRupees, setPriceRupees] = useState('0');
  const [capacityRaw, setCapacityRaw] = useState('');
  // Standalone-only:
  const [line1, setLine1] = useState('');
  const [line2, setLine2] = useState('');
  const [city, setCity] = useState('');
  const [stateRegion, setStateRegion] = useState('');
  const [pincode, setPincode] = useState('');
  const [latRaw, setLatRaw] = useState('');
  const [lngRaw, setLngRaw] = useState('');
  const [tz, setTz] = useState('Asia/Kolkata');
  const [err, setErr] = useState<string | null>(null);

  const selectedVenue = venues?.find((v) => v.id === venueId);
  // Venue events render times in the venue's tz; standalone uses the picked tz.
  const effectiveTz = scope === 'venue' ? selectedVenue?.tzName ?? 'Asia/Kolkata' : tz;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!startsAtLocal || !endsAtLocal) {
      setErr('Set a start and end time.');
      return;
    }
    if (scope === 'venue' && !venueId) {
      setErr('Pick a venue, or switch to a standalone address.');
      return;
    }
    if (scope === 'standalone' && !line1.trim() && !city.trim()) {
      setErr('Enter at least an address line or city.');
      return;
    }
    const pricePaise = Math.round(parseFloat(priceRupees || '0') * 100);
    const capacityNum = capacityRaw ? parseInt(capacityRaw, 10) : undefined;

    const base = {
      name,
      ...(description ? { description } : {}),
      startsAt: localToTzIso(startsAtLocal, effectiveTz),
      endsAt: localToTzIso(endsAtLocal, effectiveTz),
      pricePaise,
      ...(capacityNum !== undefined ? { capacity: capacityNum } : {}),
    };

    let input: CreateTenantEventInput;
    if (scope === 'venue') {
      input = { ...base, venueId };
    } else {
      const addressJson: Record<string, unknown> = {};
      if (line1.trim()) addressJson.line1 = line1.trim();
      if (line2.trim()) addressJson.line2 = line2.trim();
      if (city.trim()) addressJson.city = city.trim();
      if (stateRegion.trim()) addressJson.state = stateRegion.trim();
      if (pincode.trim()) addressJson.pincode = pincode.trim();
      input = {
        ...base,
        addressJson,
        tzName: tz,
        ...(latRaw ? { lat: parseFloat(latRaw) } : {}),
        ...(lngRaw ? { lng: parseFloat(lngRaw) } : {}),
      };
    }

    try {
      await createEvent.mutateAsync(input);
      router.push('/events');
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  if (!activeTenantId) {
    return <p className="text-sm text-slate-500">Select an organization first.</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      <Link href="/events" className="text-sm text-slate-500 hover:text-slate-800 transition-colors">
        &larr; Events
      </Link>
      <h1 className="text-xl font-semibold text-[#0f172a]">New event</h1>

      <Card title="Details" subtitle="Events are created as drafts. Submit for review when you're ready — Circls approves it before it goes live for consumers.">
        <form onSubmit={onSubmit} className="flex max-w-2xl flex-col gap-4">
          {/* Scope toggle */}
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium uppercase tracking-wide text-[#475569]">Where</label>
            <div className="inline-flex w-fit rounded-md border border-slate-200 bg-white p-0.5">
              {(['venue', 'standalone'] as Scope[]).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setScope(s)}
                  className={[
                    'rounded px-3 py-1.5 text-sm font-medium transition-colors',
                    scope === s ? 'bg-slate-900 text-white' : 'text-slate-600 hover:text-slate-900',
                  ].join(' ')}
                >
                  {s === 'venue' ? 'At a venue' : 'No venue — enter address'}
                </button>
              ))}
            </div>
          </div>

          {scope === 'venue' ? (
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium uppercase tracking-wide text-[#475569]">Venue</label>
              <select
                value={venueId}
                onChange={(e) => setVenueId(e.target.value)}
                className="w-full rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-3 py-2 text-sm text-[#0f172a]"
              >
                <option value="">Select a venue…</option>
                {venues?.map((v) => (
                  <option key={v.id} value={v.id}>{v.name}</option>
                ))}
              </select>
            </div>
          ) : (
            <div className="flex flex-col gap-3 rounded-[var(--radius)] border border-[#e5e7eb] bg-slate-50 p-3">
              <Input label="Address line 1" value={line1} onChange={(e) => setLine1(e.target.value)} placeholder="Street / building" />
              <Input label="Address line 2" value={line2} onChange={(e) => setLine2(e.target.value)} placeholder="Optional" />
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <Input label="City" value={city} onChange={(e) => setCity(e.target.value)} />
                <Input label="State" value={stateRegion} onChange={(e) => setStateRegion(e.target.value)} />
                <Input label="PIN" value={pincode} onChange={(e) => setPincode(e.target.value)} />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <Input label="Latitude" type="number" step="0.000001" value={latRaw} onChange={(e) => setLatRaw(e.target.value)} hint="Optional — for the map pin." />
                <Input label="Longitude" type="number" step="0.000001" value={lngRaw} onChange={(e) => setLngRaw(e.target.value)} />
                <Input label="Timezone" value={tz} onChange={(e) => setTz(e.target.value)} hint="IANA tz, e.g. Asia/Kolkata" />
              </div>
            </div>
          )}

          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required placeholder="Sunday Tournament" />
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium uppercase tracking-wide text-[#475569]">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="w-full rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-3 py-2 text-sm text-[#0f172a] placeholder:text-[#94a3b8] hover:border-slate-300"
              placeholder="Optional"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input label={`Starts (${effectiveTz})`} type="datetime-local" value={startsAtLocal} onChange={(e) => setStartsAtLocal(e.target.value)} required />
            <Input label={`Ends (${effectiveTz})`} type="datetime-local" value={endsAtLocal} onChange={(e) => setEndsAtLocal(e.target.value)} required />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input label="Price (₹)" type="number" min={0} step="0.01" value={priceRupees} onChange={(e) => setPriceRupees(e.target.value)} hint="Leave 0 for a free event." />
            <Input label="Capacity" type="number" min={1} value={capacityRaw} onChange={(e) => setCapacityRaw(e.target.value)} hint="Maximum seats. Leave blank for unlimited." />
          </div>

          {err && <p className="text-sm text-red-600">{err}</p>}

          <div className="flex justify-end gap-2 pt-2">
            <Link href="/events" className="rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50">
              Cancel
            </Link>
            <Button type="submit" loading={createEvent.isPending}>Create event</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @circls/partners typecheck`
Expected: no errors.

> The `useVenues` hook returns rows typed by `apps/partners/lib/api/types.ts`. Confirm that type exposes `id`, `name`, and `tzName` (the venue list page uses `v.tzName`). If `tzName` is absent from the partner venue type, add it there.

- [ ] **Step 3: Manual verification**

Run the partners app. From the Events tab click **Create event**. Verify: the "At a venue" path shows a venue dropdown; the "No venue — enter address" path reveals address + lat/lng + tz fields. Create one of each; both appear in the Events list with the correct scope badge.

- [ ] **Step 4: Commit**

```bash
git add "apps/partners/app/(protected)/events/new/page.tsx"
git commit -m "feat(partners): create-event page with venue/standalone scope toggle"
```

---

## Phase 5 — Admin review verification

### Task 12: Verify org-scoped events flow through admin review

**Files:**
- Test: `apps/api/src/services/listing_service.test.ts` (extend)

The admin review queue (`listing_service.ts`) joins events to `tenants` directly, so org-scoped events should already appear and approve. This task proves it with no production code change.

> **Scope note (deliberate deferral):** The spec called for review screens to "render the standalone address." The review queue is a single generic query across venue/arena/event/membership returning only `tenantName`/`name`/`status`/`createdAt`, so org-scoped events already surface with the **org name** (`tenantName`) — reviewers identify them by org + event name + date. Rendering the per-event standalone address would require a type-specific column in the generic queue/UI; it is **deferred** as out of scope for this plan. Revisit if reviewers need the address inline.

- [ ] **Step 1: Add the failing/guard test**

In `apps/api/src/services/listing_service.test.ts`, inside the `describe.skipIf(!runIntegration)('listing approval — integration', ...)` block, add a test (and import `events` in the file's schema import — change `import { tenants, users, venues } from '../db/schema/index.js';` to `import { events, tenants, users, venues } from '../db/schema/index.js';`):

```ts
  it('org-scoped (venue-less) events appear in the review queue and approve', async () => {
    const [ev] = await db
      .insert(events)
      .values({
        tenantId,
        venueId: null,
        addressJson: { line1: '3 Lake Rd', city: 'Pune' },
        tzName: 'Asia/Kolkata',
        name: 'Org Review Event',
        startsAt: new Date('2031-01-01T10:00:00Z'),
        endsAt: new Date('2031-01-01T12:00:00Z'),
        pricePaise: 0,
        status: 'pending_review',
      })
      .returning();

    const queue = await listListingsForReview({ type: 'event', status: 'pending_review' });
    expect(queue.some((q) => q.id === ev!.id && q.tenantName === 'ListingSvc')).toBe(true);

    const result = await approveListing({ type: 'event', id: ev!.id, actorUserId });
    expect(result.status).toBe('published');
  });
```

Also extend the `afterAll` cleanup in that block to delete events for the tenant (add before the venues delete):

```ts
    await db.execute(sql`delete from events where tenant_id = ${tenantId}`);
```

- [ ] **Step 2: Run the test**

Run: `RUN_INTEGRATION=1 pnpm --filter @circls/api test -- listing_service`
Expected: PASS — including the new test. (No production code change needed. If it fails because the queue join excludes venue-less events, that would indicate a regression to fix in `listListingsForReview`; the current `JOIN tenants t ON t.id = l.tenant_id` for events should make it pass.)

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/listing_service.test.ts
git commit -m "test(api): org-scoped events surface + approve in admin review queue"
```

---

## Final verification (run before opening a PR)

- [ ] **Full API test suite:** `RUN_INTEGRATION=1 pnpm --filter @circls/api test` — all pass.
- [ ] **Typecheck all apps:** `pnpm -r typecheck` — no errors.
- [ ] **Builds:** `pnpm -r build` — succeeds.
- [ ] **Migration numbering reconciled:** rebase onto latest `main`; renumber `0017_events_org_scoped.sql` + its `_journal.json` entry to the true next number after main's highest migration; `when` greater than the prior entry. Re-run `pnpm --filter @circls/api db:migrate` on a fresh DB to confirm clean apply.
- [ ] **Manual smoke:** create an org-scoped event in partners → see it pending in admin → approve → it appears on consumer `/events` and `/events/[id]` with the org name + address + working booking.
```
