# Memberships as first-class pages (consumer portal)

**Date:** 2026-06-18
**Status:** Approved design

## Problem

In the consumer portal, memberships currently exist only as embedded cards:

- **Venue page** (`apps/consumer/app/venues/[venueId]/page.tsx`) renders a local
  `MembershipCard` with an **inline Buy button** that opens the checkout modal directly.
- **Home page** (`apps/consumer/app/page.tsx`) renders the shared
  `components/cards/MembershipCard`, which links to `/venues/{venueId}` (or `/venues`).

There is no dedicated membership page. Events, by contrast, are first-class: each has
its own `/events/[id]` page where booking happens, plus a `/events` browse index.

## Goal

Make memberships behave like events:

- Each membership gets its own page (`/memberships/[id]`) where the purchase happens.
- All membership cards (home **and** venue) become pure navigation — clicking a card
  opens the membership page. No inline buy anywhere.
- Add a `/memberships` browse index, mirroring `/events` and `/venues`.

## Decisions (confirmed with user)

- **Checkout location:** only on the membership detail page. Cards everywhere are
  navigation-only.
- **Browse page:** yes, add a standalone `/memberships` list.
- **Venue scope:** venue pages keep showing venue-scoped **plus** tenant-wide
  memberships (current `GET /v1/consumer/venues/:venueId/memberships` behaviour
  is preserved).

## Out of scope (YAGNI)

- No membership images. Memberships have no image field; cards and the detail page use
  the existing ink/gold gradient motif.
- No changes to purchase/checkout logic, the `userMemberships` table, or the partner
  portal.
- No date/category grouping on the browse page (events group by day because they are
  time-based; memberships are not).

## Backend — `apps/api`

### 1. `getPublicMembershipById(id)` — `src/services/consumer_service.ts`

New service function returning `PublicMembershipWithScope | null`. Same visibility gate
as `listPublicMembershipsAcrossVenues`:

- membership `status = 'active'`
- tenant `status = 'active'`
- `venue_id IS NULL` (tenant-wide) **or** the owning venue `status = 'active'`

Enriches the row with `scopeName` (venue name, or tenant/brand name for tenant-wide)
and `venueTags` (owning venue's tags, empty for tenant-wide). Returns `null` when the
membership does not exist or fails the visibility gate.

### 2. `GET /v1/consumer/memberships/:membershipId` — `src/routes/consumer.ts`

New public route (under `publicLimit`), placed alongside the existing
`GET /v1/consumer/memberships`. Calls `getPublicMembershipById`; throws
`NotFound('Membership not found', 'membership_not_found')` when null. Mirrors
`GET /v1/consumer/events/:id`.

### 3. Enrich `listPublicMemberships(venueId)` — `src/services/consumer_service.ts`

Change its return type from `Membership[]` to `PublicMembershipWithScope[]`, adding
`scopeName` + `venueTags` via the same joins used by
`listPublicMembershipsAcrossVenues`. This unifies the venue and home card shape so both
pages use the same shared card component. The `GET /v1/consumer/venues/:venueId/memberships`
route returns the enriched rows unchanged in shape (`{ rows }`).

## Consumer web — `apps/consumer`

### 4. API hooks/types — `lib/api/consumer.ts`, `lib/api/types.ts`

- Add `useMembership(id)` → `GET /v1/consumer/memberships/${id}`, returning
  `PublicMembershipWithScope`, `enabled: Boolean(id)`. Mirrors `useEvent`.
- Update `useVenueMemberships` return type to `PublicMembershipWithScope[]`.
- Types: `PublicMembershipWithScope` already exists in `types.ts`; reuse it.

### 5. Detail page — `app/memberships/[id]/page.tsx` (new)

Modeled on `app/events/[id]/page.tsx`:

- Loading / error / not-found states matching the event page.
- Header block in the ink/gold membership style: scope label (`scopeName`), name,
  description.
- Price + duration line: `formatPaise(pricePaise)` `/ {durationDays} days`.
- Optional benefits: render `benefits` **only** if it is a simple string array or a flat
  key/value map; otherwise omit. (It is an opaque `Record<string, unknown>` today.)
- **Buy button** → `openCheckout({ kind: 'membership', membershipId, title: name }, prefill)`
  with name/contact prefill from `useAuth`, exactly as the current venue/home cards do.
- For venue-scoped memberships: a "More at {scopeName}" link to `/venues/{venueId}`.
  For tenant-wide: a "Brand-wide" badge.

### 6. Browse page — `app/memberships/page.tsx` (new)

Modeled on `app/events/page.tsx` / `app/venues/page.tsx`:

- `useAllMemberships(100)`.
- Heading + subtitle, skeleton (`CardSkeleton`) loading state, `EmptyState` when none.
- Responsive grid of the shared `MembershipCard`. No grouping.

### 7. Shared card — `components/cards/MembershipCard.tsx`

Change `href` from `/venues/{venueId}` (or `/venues`) to `/memberships/{membership.id}`.
Card content otherwise unchanged (already shows scope, name, description, price/duration,
"View").

### 8. Venue page — `app/venues/[venueId]/page.tsx`

- Delete the local inline-buy `MembershipCard` component (current lines ~285–313) and its
  now-unused imports (`useAuth`/`useCheckoutModal` only if no other local component needs
  them — `ArenaCard`/`EventCard` still use them, so keep those imports).
- Render the shared `components/cards/MembershipCard` in the Memberships section so cards
  navigate to the detail page.
- Section continues to show venue-scoped + tenant-wide via the enriched
  `useVenueMemberships`.

### 9. Home page — `app/page.tsx`

Add `viewAllHref="/memberships"` to the Memberships `HScroll` (it currently has none),
matching the Venues and Events rows.

## Testing

- Backend: extend `src/services/consumer_service.test.ts` (or the existing membership
  tests) to cover `getPublicMembershipById` — visible venue-scoped, visible tenant-wide,
  inactive membership → null, inactive venue (venue-scoped) → null, inactive tenant →
  null, unknown id → null. Confirm `listPublicMemberships` now returns scope fields.
- Manual/web: card click navigates to detail page from both home and venue; detail page
  Buy opens checkout and completes (free + paid); browse page renders and links.

## File touch list

Backend:
- `apps/api/src/services/consumer_service.ts` (new fn + enrich existing)
- `apps/api/src/routes/consumer.ts` (new route)
- `apps/api/src/services/consumer_service.test.ts` (tests)

Consumer:
- `apps/consumer/lib/api/consumer.ts` (new hook + return type)
- `apps/consumer/app/memberships/[id]/page.tsx` (new)
- `apps/consumer/app/memberships/page.tsx` (new)
- `apps/consumer/components/cards/MembershipCard.tsx` (href)
- `apps/consumer/app/venues/[venueId]/page.tsx` (use shared card)
- `apps/consumer/app/page.tsx` (viewAllHref)
