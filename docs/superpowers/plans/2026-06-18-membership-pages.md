# Memberships as First-Class Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give consumer-portal memberships their own pages (detail + browse) like events, with all cards becoming navigation and purchase happening only on the detail page.

**Architecture:** Add a single-membership public API (`GET /v1/consumer/memberships/:id`) backed by a new `getPublicMembershipById` service fn; enrich the existing venue-memberships service to return scope so one shared card serves both home and venue pages; add two new consumer routes (`/memberships/[id]`, `/memberships`) modeled on the event pages; repoint the shared `MembershipCard` and the venue page at the detail route.

**Tech Stack:** TypeScript, Fastify + Drizzle (apps/api), Next.js 15 App Router + TanStack Query + Tailwind (apps/consumer), Vitest.

## Global Constraints

- Package manager: `pnpm@9.12.0`. Run app-scoped commands with `pnpm --filter @circls/api <script>` / `pnpm --filter @circls/consumer <script>`.
- Backend service tests are integration tests gated by the file-level `runIntegration` flag via `describe.skipIf(!runIntegration)`; they require a live DB (`pingDb()` in `beforeAll`). When no DB is configured they skip — that is expected; do not delete the gate.
- Money is paise (`pricePaise`), rendered with `formatPaise` from `@/lib/format`.
- Membership scope: `venueId === null` means tenant-wide (brand); otherwise venue-scoped. Visibility gate = membership `status='active'` AND tenant `status='active'` AND (`venueId IS NULL` OR owning venue `status='active'`).
- No membership images. Cards and the detail page use the existing ink/gold gradient styling — no `ImageCarousel`/`SportImage`.
- Keep partner portal, `userMemberships`, and checkout/purchase logic untouched.

---

### Task 1: Backend — `getPublicMembershipById` service fn

**Files:**
- Modify: `apps/api/src/services/consumer_service.ts` (add fn after `listPublicMembershipsAcrossVenues`, ~line 338)
- Test: `apps/api/src/services/consumer_service.test.ts` (new `describe` block)

**Interfaces:**
- Consumes: existing `PublicMembershipWithScope` interface (`consumer_service.ts:296`), `db`, `memberships`/`venues`/`tenants` schema, `and`/`eq`/`sql` from drizzle.
- Produces: `export async function getPublicMembershipById(id: string): Promise<PublicMembershipWithScope | null>`

- [ ] **Step 1: Write the failing test**

Add this block to `apps/api/src/services/consumer_service.test.ts`. It reuses the same fixtures-style setup as the existing "consumer memberships across venues" block. Also import the new fn at the top import group (the `from '../...consumer_service.js'` import list near line 9–15):

```ts
// add `getPublicMembershipById,` to the existing import from the consumer_service module

describe.skipIf(!runIntegration)('getPublicMembershipById', () => {
  const tag = `mbyid-${Date.now()}`;
  let tenantId: string;
  let venueId: string;
  let pendingVenueId: string;
  let suspTenantId: string;
  let scopedId: string;
  let tenantWideId: string;
  let inactiveId: string;
  let pendingVenueMembId: string;
  let suspMembId: string;

  beforeAll(async () => {
    await pingDb();
    const [t] = await db.insert(tenants).values({ name: `ById Brand ${tag}`, slug: tag }).returning();
    tenantId = t!.id;
    const [v] = await db
      .insert(venues)
      .values({ tenantId, name: `ById Venue ${tag}`, status: 'active', tags: ['Tennis'] })
      .returning();
    venueId = v!.id;
    const [pv] = await db
      .insert(venues)
      .values({ tenantId, name: `ById Pending ${tag}`, status: 'pending_review' })
      .returning();
    pendingVenueId = pv!.id;

    const mkMemb = async (name: string, venue: string | null, status: 'active' | 'inactive') => {
      const [m] = await db
        .insert(memberships)
        .values({ tenantId, venueId: venue, name, durationDays: 30, status })
        .returning();
      return m!.id;
    };
    scopedId = await mkMemb('Scoped', venueId, 'active');
    tenantWideId = await mkMemb('Wide', null, 'active');
    inactiveId = await mkMemb('Inactive', venueId, 'inactive');
    pendingVenueMembId = await mkMemb('OnPendingVenue', pendingVenueId, 'active');

    const [st] = await db.insert(tenants).values({ name: `ByIdSusp ${tag}`, slug: `${tag}-susp`, status: 'suspended' }).returning();
    suspTenantId = st!.id;
    const [sm] = await db
      .insert(memberships)
      .values({ tenantId: suspTenantId, venueId: null, name: 'SuspWide', durationDays: 30, status: 'active' })
      .returning();
    suspMembId = sm!.id;
  });

  afterAll(async () => {
    await db.execute(sql`delete from memberships where tenant_id in (${tenantId}, ${suspTenantId})`);
    await db.execute(sql`delete from venues where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenants where id in (${tenantId}, ${suspTenantId})`);
  });

  it('returns a venue-scoped membership with scope', async () => {
    const m = await getPublicMembershipById(scopedId);
    expect(m).not.toBeNull();
    expect(m!.id).toBe(scopedId);
    expect(m!.venueId).toBe(venueId);
    expect(m!.scopeName).toBe(`ById Venue ${tag}`);
    expect(m!.venueTags).toEqual(['Tennis']);
  });

  it('returns a tenant-wide membership with brand scope and empty tags', async () => {
    const m = await getPublicMembershipById(tenantWideId);
    expect(m).not.toBeNull();
    expect(m!.venueId).toBeNull();
    expect(m!.scopeName).toBe(`ById Brand ${tag}`);
    expect(m!.venueTags).toEqual([]);
  });

  it('returns null for inactive, non-active-venue-scoped, suspended-tenant, and unknown', async () => {
    expect(await getPublicMembershipById(inactiveId)).toBeNull();
    expect(await getPublicMembershipById(pendingVenueMembId)).toBeNull();
    expect(await getPublicMembershipById(suspMembId)).toBeNull();
    expect(await getPublicMembershipById('00000000-0000-0000-0000-000000000000')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @circls/api test -- consumer_service`
Expected: FAIL — `getPublicMembershipById is not a function` / import error (or, with no DB, the block is skipped; in that case verify failure via typecheck in Step 4 instead — the import of a non-existent export makes `pnpm --filter @circls/api typecheck` fail).

- [ ] **Step 3: Write minimal implementation**

Add to `apps/api/src/services/consumer_service.ts` immediately after `listPublicMembershipsAcrossVenues` (after line 338):

```ts
/** A single public membership by id, enriched with scope, or null when it does
 *  not exist or fails the public visibility gate (same rules as
 *  listPublicMembershipsAcrossVenues). */
export async function getPublicMembershipById(
  id: string,
): Promise<PublicMembershipWithScope | null> {
  const rows = await db
    .select({ m: memberships, venueName: venues.name, venueTags: venues.tags, tenantName: tenants.name })
    .from(memberships)
    .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
    .leftJoin(venues, eq(venues.id, memberships.venueId))
    .where(
      and(
        eq(memberships.id, id),
        eq(memberships.status, 'active'),
        eq(tenants.status, 'active'),
        sql`(${memberships.venueId} is null or ${venues.status} = 'active')`,
      ),
    )
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    ...r.m,
    venueId: r.m.venueId,
    scopeName: r.venueName ?? r.tenantName,
    venueTags: r.venueTags ?? [],
  };
}
```

- [ ] **Step 4: Run test + typecheck to verify they pass**

Run: `pnpm --filter @circls/api typecheck && pnpm --filter @circls/api test -- consumer_service`
Expected: typecheck passes; tests PASS (or skip cleanly if no DB).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/consumer_service.ts apps/api/src/services/consumer_service.test.ts
git commit -m "feat(api): getPublicMembershipById service fn"
```

---

### Task 2: Backend — enrich `listPublicMemberships(venueId)` with scope

**Files:**
- Modify: `apps/api/src/services/consumer_service.ts:281-293`
- Test: `apps/api/src/services/consumer_service.test.ts` (extend an existing membership block or add a focused `it`)

**Interfaces:**
- Consumes: `PublicMembershipWithScope`, `assertVenueVisible(venueId)` (returns the venue row incl. `tenantId`), schema tables.
- Produces: `listPublicMemberships(venueId: string): Promise<PublicMembershipWithScope[]>` (return type widened from `Membership[]`).

- [ ] **Step 1: Write the failing test**

Add `listPublicMemberships,` to the consumer_service import group, then add this block:

```ts
describe.skipIf(!runIntegration)('listPublicMemberships (venue scope enrichment)', () => {
  const tag = `mvscope-${Date.now()}`;
  let tenantId: string;
  let venueId: string;

  beforeAll(async () => {
    await pingDb();
    const [t] = await db.insert(tenants).values({ name: `VScope Brand ${tag}`, slug: tag }).returning();
    tenantId = t!.id;
    const [v] = await db
      .insert(venues)
      .values({ tenantId, name: `VScope Venue ${tag}`, status: 'active', tags: ['Padel'] })
      .returning();
    venueId = v!.id;
    await db.insert(memberships).values([
      { tenantId, venueId, name: 'VScoped', durationDays: 30, status: 'active' },
      { tenantId, venueId: null, name: 'VWide', durationDays: 30, status: 'active' },
    ]);
  });

  afterAll(async () => {
    await db.execute(sql`delete from memberships where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from venues where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
  });

  it('returns venue-scoped + tenant-wide with scope fields', async () => {
    const rows = await listPublicMemberships(venueId);
    const scoped = rows.find((m) => m.name === 'VScoped')!;
    const wide = rows.find((m) => m.name === 'VWide')!;
    expect(scoped.scopeName).toBe(`VScope Venue ${tag}`);
    expect(scoped.venueTags).toEqual(['Padel']);
    expect(wide.venueId).toBeNull();
    expect(wide.scopeName).toBe(`VScope Brand ${tag}`);
    expect(wide.venueTags).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @circls/api test -- consumer_service`
Expected: FAIL — `scopeName`/`venueTags` undefined on returned rows (or typecheck error referencing missing props if DB skipped).

- [ ] **Step 3: Write minimal implementation**

Replace `apps/api/src/services/consumer_service.ts:281-293` with:

```ts
export async function listPublicMemberships(venueId: string): Promise<PublicMembershipWithScope[]> {
  const venue = await assertVenueVisible(venueId);
  const rows = await db
    .select({ m: memberships, venueName: venues.name, venueTags: venues.tags, tenantName: tenants.name })
    .from(memberships)
    .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
    .leftJoin(venues, eq(venues.id, memberships.venueId))
    .where(
      and(
        eq(memberships.tenantId, venue.tenantId),
        eq(memberships.status, 'active'),
        sql`(${memberships.venueId} is null or ${memberships.venueId} = ${venueId})`,
      ),
    );
  return rows.map((r) => ({
    ...r.m,
    venueId: r.m.venueId,
    scopeName: r.venueName ?? r.tenantName,
    venueTags: r.venueTags ?? [],
  }));
}
```

Note: the `PublicMembershipWithScope` interface is defined at line ~296, *after* this function. Function declarations are hoisted and the interface is a type-only reference, so forward use in the return type is fine in TypeScript. If the linter objects, move the `interface PublicMembershipWithScope` block above `listPublicMemberships` (no behaviour change).

- [ ] **Step 4: Run test + typecheck to verify they pass**

Run: `pnpm --filter @circls/api typecheck && pnpm --filter @circls/api test -- consumer_service`
Expected: typecheck passes; tests PASS (or skip if no DB).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/consumer_service.ts apps/api/src/services/consumer_service.test.ts
git commit -m "feat(api): enrich listPublicMemberships with venue/tenant scope"
```

---

### Task 3: Backend — `GET /v1/consumer/memberships/:membershipId` route

**Files:**
- Modify: `apps/api/src/routes/consumer.ts` (after the `/v1/consumer/memberships` handler, line 93)

**Interfaces:**
- Consumes: `getPublicMembershipById` (Task 1), `NotFound`, `publicLimit`.
- Produces: HTTP `GET /v1/consumer/memberships/:membershipId` → `PublicMembershipWithScope` JSON, or 404 `membership_not_found`.

- [ ] **Step 1: Add the route**

Confirm `getPublicMembershipById` is in the import list from `../services/consumer_service.js` at the top of `consumer.ts` (add it if missing). Then insert immediately after the closing `});` of the `/v1/consumer/memberships` handler (line 93):

```ts
  app.get('/v1/consumer/memberships/:membershipId', { config: publicLimit }, async (req) => {
    const { membershipId } = req.params as { membershipId: string };
    const m = await getPublicMembershipById(membershipId);
    if (!m) throw new NotFound('Membership not found', 'membership_not_found');
    return m;
  });
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @circls/api typecheck`
Expected: PASS.

- [ ] **Step 3: Build (route wiring sanity)**

Run: `pnpm --filter @circls/api build`
Expected: PASS (compiles).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/consumer.ts
git commit -m "feat(api): GET /v1/consumer/memberships/:id public route"
```

---

### Task 4: Consumer — `useMembership` hook + `useVenueMemberships` type

**Files:**
- Modify: `apps/consumer/lib/api/consumer.ts:53-61` (return type) and after `useAllMemberships` (line 98)

**Interfaces:**
- Consumes: `apiFetch`, `PublicMembershipWithScope` (already imported at top of `consumer.ts`).
- Produces: `useMembership(membershipId: string)` returning a query of `PublicMembershipWithScope`; `useVenueMemberships` now returns `PublicMembershipWithScope[]`.

- [ ] **Step 1: Update `useVenueMemberships` return type**

Replace the `apiFetch<{ rows: PublicMembership[] }>` in `useVenueMemberships` (line 57) with `PublicMembershipWithScope`:

```ts
export function useVenueMemberships(venueId: string) {
  return useQuery({
    queryKey: ['venue-memberships', venueId],
    queryFn: () =>
      apiFetch<{ rows: PublicMembershipWithScope[] }>(`/v1/consumer/venues/${venueId}/memberships`),
    enabled: Boolean(venueId),
    select: (data) => data.rows,
  });
}
```

- [ ] **Step 2: Add `useMembership` after `useAllMemberships`**

Insert after line 98 (the close of `useAllMemberships`):

```ts
/** A single public membership (venue-scoped or tenant-wide) by id. */
export function useMembership(membershipId: string) {
  return useQuery({
    queryKey: ['membership', membershipId],
    queryFn: () =>
      apiFetch<PublicMembershipWithScope>(`/v1/consumer/memberships/${membershipId}`),
    enabled: Boolean(membershipId),
  });
}
```

- [ ] **Step 3: Remove now-unused `PublicMembership` import if unreferenced**

Check whether `PublicMembership` is still used anywhere in `consumer.ts` after the type change (`grep -n "PublicMembership\b" apps/consumer/lib/api/consumer.ts`). If it no longer appears, drop it from the import block (lines 4-18). If it is still used, leave it.

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @circls/consumer typecheck`
Expected: PASS (the venue page still compiles because its local card will be replaced in Task 8 — if typecheck fails here on the venue page's local `MembershipCard` expecting `PublicMembership`, that is acceptable to defer; the next step verifies). If the venue page errors, proceed to commit anyway only if the error is solely the venue page's local card prop mismatch, which Task 8 fixes. Otherwise fix here.

> Note for executor: to keep each task green, you may do Task 8's venue-page edit before running this typecheck. Either order is fine as long as both are committed.

- [ ] **Step 5: Commit**

```bash
git add apps/consumer/lib/api/consumer.ts
git commit -m "feat(consumer): useMembership hook + scoped useVenueMemberships"
```

---

### Task 5: Consumer — repoint shared `MembershipCard` to the detail page

**Files:**
- Modify: `apps/consumer/components/cards/MembershipCard.tsx:12`

**Interfaces:**
- Consumes: `PublicMembershipWithScope`.
- Produces: a `MembershipCard` whose link target is `/memberships/{id}`.

- [ ] **Step 1: Change the href**

Replace line 12:

```ts
  const href = membership.venueId ? `/venues/${membership.venueId}` : '/venues';
```

with:

```ts
  const href = `/memberships/${membership.id}`;
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @circls/consumer typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/consumer/components/cards/MembershipCard.tsx
git commit -m "feat(consumer): membership card links to detail page"
```

---

### Task 6: Consumer — membership detail page `/memberships/[id]`

**Files:**
- Create: `apps/consumer/app/memberships/[id]/page.tsx`

**Interfaces:**
- Consumes: `useMembership` (Task 4), `useCheckoutModal`, `useAuth`, `formatPaise`, `Badge`/`Button`/`Card` from `@/lib/ui`.
- Produces: route `/memberships/{id}` with a Buy action via `openCheckout({ kind: 'membership', membershipId, title })`.

- [ ] **Step 1: Create the page**

```tsx
'use client';
import { use } from 'react';
import Link from 'next/link';
import { Header } from '@/components/Header';
import { useMembership } from '@/lib/api/consumer';
import { useAuth } from '@/lib/firebase/auth_context';
import { formatPaise } from '@/lib/format';
import { useCheckoutModal } from '@/lib/checkout/CheckoutProvider';
import { Badge, Button, Card } from '@/lib/ui';

/** Render benefits only when they are a simple string[] or a flat string→string/number
 *  map. The field is an opaque JSONB blob, so anything else is skipped. */
function Benefits({ benefits }: { benefits: Record<string, unknown> }) {
  const items: string[] = Array.isArray(benefits)
    ? (benefits as unknown[]).filter((b): b is string => typeof b === 'string')
    : Object.entries(benefits)
        .filter(([, v]) => typeof v === 'string' || typeof v === 'number')
        .map(([k, v]) => `${k}: ${v}`);
  if (items.length === 0) return null;
  return (
    <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-text-secondary">
      {items.map((b) => <li key={b}>{b}</li>)}
    </ul>
  );
}

export default function MembershipPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const membershipQ = useMembership(id);
  const { openCheckout } = useCheckoutModal();
  const { user } = useAuth();
  const m = membershipQ.data;

  return (
    <div className="min-h-screen">
      <Header />
      <main className="mx-auto max-w-3xl px-4 py-8">
        {membershipQ.isLoading ? (
          <p className="text-sm text-text-secondary">Loading membership…</p>
        ) : membershipQ.isError ? (
          <p className="text-sm text-red-600">
            {membershipQ.error instanceof Error ? membershipQ.error.message : 'Failed to load membership'}
          </p>
        ) : !m ? (
          <p className="text-sm text-text-secondary">Membership not found.</p>
        ) : (
          <>
            <div className="mb-6 overflow-hidden rounded-card border border-ink-soft bg-gradient-to-br from-ink to-ink-soft p-6 text-white">
              <div className="flex items-center gap-2">
                <p className="text-[10px] font-bold uppercase tracking-widest text-gold-500">{m.scopeName}</p>
                {m.venueId === null && <Badge tone="neutral" label="Brand-wide" />}
              </div>
              <h1 className="mt-1 font-display text-3xl font-semibold">{m.name}</h1>
              {m.description && <p className="mt-2 text-sm text-white/70">{m.description}</p>}
              <div className="mt-4 font-display text-2xl font-semibold">
                {formatPaise(m.pricePaise)}{' '}
                <span className="font-sans text-xs text-white/70">/ {m.durationDays} days</span>
              </div>
            </div>

            <Card className="flex flex-col gap-3">
              <Benefits benefits={m.benefits} />
              {m.venueId && (
                <Link href={`/venues/${m.venueId}`} className="text-sm text-gold-600 underline">
                  More at {m.scopeName}
                </Link>
              )}
              <div className="pt-2">
                <Button
                  onClick={() => {
                    const prefill: { name?: string; contact?: string } = {};
                    if (user?.displayName) prefill.name = user.displayName;
                    if (user?.phoneNumber) prefill.contact = user.phoneNumber;
                    openCheckout({ kind: 'membership', membershipId: m.id, title: m.name }, prefill);
                  }}
                >
                  {m.pricePaise === 0 ? 'Get membership' : 'Buy'}
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
Expected: PASS. (If `PublicMembershipWithScope.benefits` typing trips the `Benefits` helper, confirm the field exists on the type in `apps/consumer/lib/api/types.ts:62-72`; it is `Record<string, unknown>`.)

- [ ] **Step 3: Commit**

```bash
git add apps/consumer/app/memberships/[id]/page.tsx
git commit -m "feat(consumer): membership detail page with purchase"
```

---

### Task 7: Consumer — membership browse page `/memberships`

**Files:**
- Create: `apps/consumer/app/memberships/page.tsx`

**Interfaces:**
- Consumes: `useAllMemberships`, shared `MembershipCard`, `CardSkeleton`, `EmptyState`.
- Produces: route `/memberships` (a grid index).

- [ ] **Step 1: Create the page**

```tsx
'use client';
import { Header } from '@/components/Header';
import { MembershipCard } from '@/components/cards/MembershipCard';
import { CardSkeleton } from '@/components/Skeleton';
import { EmptyState } from '@/components/EmptyState';
import { useAllMemberships } from '@/lib/api/consumer';

export default function MembershipsPage() {
  const memberships = useAllMemberships(100);
  const rows = memberships.data ?? [];

  return (
    <div className="min-h-screen">
      <Header />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <h1 className="mb-1 font-display text-3xl font-semibold text-ink">Memberships</h1>
        <p className="mb-8 text-sm text-text-secondary">Plans and passes across every venue.</p>

        {memberships.isLoading ? (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => <CardSkeleton key={i} />)}
          </div>
        ) : memberships.isError ? (
          <p className="text-sm text-red-600">
            {memberships.error instanceof Error ? memberships.error.message : 'Failed to load memberships'}
          </p>
        ) : rows.length === 0 ? (
          <EmptyState title="No memberships yet" body="There are no memberships available right now. Check back soon." />
        ) : (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {rows.map((m) => <MembershipCard key={m.id} membership={m} />)}
          </div>
        )}
      </main>
    </div>
  );
}
```

- [ ] **Step 2: Verify `CardSkeleton`/`EmptyState` import paths**

Run: `grep -n "export" apps/consumer/components/Skeleton.tsx apps/consumer/components/EmptyState.tsx`
Expected: confirms `CardSkeleton` is exported from `components/Skeleton` and `EmptyState` from `components/EmptyState` (same imports `app/events/page.tsx` uses). If names differ, match the events page exactly.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @circls/consumer typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/consumer/app/memberships/page.tsx
git commit -m "feat(consumer): memberships browse page"
```

---

### Task 8: Consumer — venue page uses shared navigation card

**Files:**
- Modify: `apps/consumer/app/venues/[venueId]/page.tsx`

**Interfaces:**
- Consumes: shared `MembershipCard` from `@/components/cards/MembershipCard`, enriched `useVenueMemberships` (Task 4).
- Produces: venue Memberships section rendering navigation cards (no inline buy).

- [ ] **Step 1: Import the shared card**

Add to the imports at the top of the file:

```ts
import { MembershipCard } from '@/components/cards/MembershipCard';
```

- [ ] **Step 2: Delete the local `MembershipCard` component**

Remove the local `function MembershipCard({ membership }: { membership: PublicMembership }) { ... }` block (currently lines ~285-313). The Memberships `<section>` (lines 97-111) already calls `<MembershipCard key={m.id} membership={m} />`; it now resolves to the imported shared card.

- [ ] **Step 3: Clean up now-unused references**

- Remove `PublicMembership` from the `import type { PublicArena, PublicEvent, PublicMembership } from '@/lib/api/types';` line (line 13) — the local card was its only user here. Keep `PublicArena` and `PublicEvent` (used by `ArenaCard`/local `EventCard`).
- Leave `useAuth` and `useCheckoutModal` imports — the local `ArenaCard` and `EventCard` still use them.

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @circls/consumer typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/consumer/app/venues/[venueId]/page.tsx
git commit -m "feat(consumer): venue page memberships navigate to detail page"
```

---

### Task 9: Consumer — home page "view all" link

**Files:**
- Modify: `apps/consumer/app/page.tsx:58`

**Interfaces:**
- Consumes: existing `HScroll` (`viewAllHref` prop, already used by the Venues/Events rows).
- Produces: Memberships row with a "view all" link to `/memberships`.

- [ ] **Step 1: Add `viewAllHref`**

Change line 58 from:

```tsx
          <HScroll title="Memberships">
```

to:

```tsx
          <HScroll title="Memberships" viewAllHref="/memberships">
```

- [ ] **Step 2: Typecheck + full consumer build**

Run: `pnpm --filter @circls/consumer typecheck && pnpm --filter @circls/consumer build`
Expected: typecheck PASS; `next build` succeeds and lists the new routes `/memberships` and `/memberships/[id]`.

- [ ] **Step 3: Commit**

```bash
git add apps/consumer/app/page.tsx
git commit -m "feat(consumer): link home memberships row to browse page"
```

---

### Task 10: Full verification sweep

**Files:** none (verification only).

- [ ] **Step 1: Backend typecheck + build + tests**

Run: `pnpm --filter @circls/api typecheck && pnpm --filter @circls/api build && pnpm --filter @circls/api test`
Expected: all PASS (membership integration tests pass with a DB, or skip cleanly without one).

- [ ] **Step 2: Consumer typecheck + build**

Run: `pnpm --filter @circls/consumer typecheck && pnpm --filter @circls/consumer build`
Expected: PASS; build output includes `/memberships` and `/memberships/[id]`.

- [ ] **Step 3: Manual smoke (if a dev environment is available)**

Run the API (`pnpm dev`) and consumer (`pnpm --filter @circls/consumer dev`, port 3003), then verify:
- Home "Memberships" row: card click → `/memberships/{id}`; "view all" → `/memberships`.
- `/memberships`: grid renders; card click → detail page.
- Venue page: membership card click → detail page (no inline buy button present).
- Detail page: Buy opens the checkout modal; free membership shows "Get membership" and completes; paid shows "Buy" and reaches payment.
- Tenant-wide membership detail shows the "Brand-wide" badge and no "More at" link; venue-scoped shows "More at {venue}".

- [ ] **Step 4: Help-centre check (repo rule)**

Per `CLAUDE.md`, this changes a partner-adjacent consumer flow but not partner functionality, API base paths, statuses, roles, webhooks, or upload limits. Confirm no `apps/partners/content/help/*.md` article documents consumer membership navigation; if one does, update it in this branch. Expected: no partner help article applies — note this in the PR description.

---

## Notes for the executor

- Tasks 1–3 (backend) and 4–9 (consumer) are mostly independent, but Task 4 widens `useVenueMemberships`'s type, which Task 8 depends on, and Tasks 6/7 depend on Task 4's `useMembership`. Recommended order is as written.
- If running without a DB, backend service tests skip — rely on `typecheck` + `build` for backend confidence and flag that integration tests were not exercised.
