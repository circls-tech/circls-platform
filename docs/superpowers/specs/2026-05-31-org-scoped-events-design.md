# Org-Scoped Events (Venue-less Events) — Design

**Date:** 2026-05-31
**Status:** Approved (pending spec review)

## Problem

Today every event is **venue-scoped**: `events.venue_id` is `NOT NULL`, events carry no
location data of their own (they inherit address / `lat` / `lng` / `tz_name` from the venue),
and consumers reach events only through a venue page (event cards link to
`/venues/{venueId}`, and the consumer event query `INNER JOIN`s venues).

We want to onboard an **organization that posts events without owning a venue**. When no venue
is provided, the partner supplies a **standalone address** instead. This mirrors the existing
**dual-scoping of memberships** (`memberships.venue_id` is nullable: `NULL` = org-wide,
set = venue-scoped).

## Goals

- Events can be **venue-scoped** (as today) or **org-scoped** (no venue, standalone address).
- An org can be onboarded and post events with **no venue** (already allowed at the data layer;
  this closes the flow gap).
- Standalone events capture **address + coordinates + timezone**, at parity with venues, so they
  render correct times and can pin on a map.
- Org-scoped events go through the **same admin review lifecycle** as venue events.
- Surface **Events** and **Memberships** as top-level tabs in the partners portal (today Events
  are reachable only via a venue, and Memberships are buried inside Settings).

## Non-Goals

- No change to the booking/registration data model (bookings key off `event_id` and already work
  without venue context).
- No PostGIS / spatial indexing — keep raw `lat`/`lng` floats like venues.
- No auto-publish path for org events (they are reviewed like venue events).
- No reusable "standalone location" entity — location lives inline on the event (see Approach).

## Approach: nullable `venue_id` + inline location columns

Chosen over (B) a separate `event_locations` 1:1 table (extra table + join, no benefit here) and
(C) a polymorphic `location_ref` (over-engineered). Explicitly **not** the "auto-create a hidden
venue" shortcut — it pollutes the venue list and diverges from the membership precedent.

This directly mirrors:
- **memberships dual-scoping** — `venue_id` nullable; `NULL` ⇒ org-scoped.
- **venues location shape** — `address_json` (jsonb) + `lat`/`lng` (double precision) + `tz_name`
  (IANA, default `Asia/Kolkata`).

### Scope semantics

- `venue_id` **set** → venue event. Location columns stay `NULL`; effective location is read from
  the venue (single source of truth, no drift).
- `venue_id` **NULL** → standalone event. `address_json` + `tz_name` are **required**; `lat`/`lng`
  are best-effort (geocoding can fail, exactly like venues).

`tenant_id` remains required on every event regardless of scope.

## Data Model

### `events` table changes

```sql
-- venue_id becomes nullable (matches memberships)
ALTER TABLE "events" ALTER COLUMN "venue_id" DROP NOT NULL;

-- inline location, used only when venue_id IS NULL
ALTER TABLE "events" ADD COLUMN "address_json" jsonb;
ALTER TABLE "events" ADD COLUMN "lat" double precision;
ALTER TABLE "events" ADD COLUMN "lng" double precision;
ALTER TABLE "events" ADD COLUMN "tz_name" text;

-- exactly-one-scope integrity
ALTER TABLE "events" ADD CONSTRAINT "events_scope_chk" CHECK (
  (venue_id IS NOT NULL
     AND address_json IS NULL AND lat IS NULL AND lng IS NULL AND tz_name IS NULL)
  OR
  (venue_id IS NULL
     AND address_json IS NOT NULL AND tz_name IS NOT NULL)
);
```

`lat`/`lng` are intentionally absent from the CHECK so a standalone event can be created before
geocoding resolves (or if it fails).

### Drizzle schema (`apps/api/src/db/schema/events.ts`)

```ts
venueId: uuid('venue_id').references(() => venues.id),   // drop .notNull()
addressJson: jsonb('address_json').$type<Record<string, unknown>>(),
lat: doublePrecision('lat'),
lng: doublePrecision('lng'),
tzName: text('tz_name'),
```

### Effective-location resolution

A single helper resolves location for read paths:
`venue_id ? { name: venue.name, addressJson: venue.addressJson, lat, lng, tzName: venue.tzName }`
else the event's own columns (with `name` falling back to the tenant/org name).

## API (`apps/api`)

- **Keep** `POST /v1/venues/:venueId/events` (venue path, unchanged behavior).
- **New** `POST /v1/tenants/:tenantId/events`:
  - Body is one of: `{ venueId }` **or** `{ addressJson, lat?, lng?, tzName }`, plus the common
    event fields (`name`, `description?`, `startsAt`, `endsAt`, `pricePaise`, `capacity?`).
  - `requireTenantMembership(user.id, tenantId)`.
  - Service validates **exactly one** scope; if `venueId` given, verify the venue belongs to the
    tenant; if standalone, require `addressJson` + `tzName`.
- `events_service.createEvent`: `venueId` becomes optional; add standalone location fields; insert
  `venue_id` / location accordingly.
- Existing `GET` / `PATCH` / `publish` / `cancel` routes operate by event id — audit each for
  null-venue assumptions and use the effective-location helper where they surface a venue.
- **Lifecycle unchanged:** both scopes follow `draft → pending_review → published` (and
  `cancelled` / `rejected`). Admin review applies to org events too.

## Consumer (`apps/api` + `apps/consumer`)

### API
- `consumer_service.listPublicUpcomingEvents` and venue-scoped queries: change `innerJoin(venues)`
  → `leftJoin(venues)`. Project an effective-location shape:
  `locationName` (venue name or org name), `addressJson`, `lat`, `lng`, `tzName`, `isStandalone`.
- **New** `GET /v1/consumer/events/:id` → `getPublicEventById` returning the event with effective
  location, for the standalone detail page. Only returns `published` events of `active` tenants.

### UI
- **New unified `/events/[id]` detail + booking page** used by **every** event (venue and
  standalone). Shows the resolved location (venue or org + address) and a map when `lat`/`lng`
  exist; hosts the booking action.
- `EventCard` links to `/events/{id}` (not `/venues/{venueId}`); renders `locationName` and
  address. Venue pages may still list their events and can link to the same event page.

## Partners (`apps/partners`)

### Navigation / IA (folds in reviewer tip)
- Add two top-level sidebar nav items as siblings to **Venues** in `NAV_LINKS`
  (`app/(protected)/layout.tsx:11`): **Events** and **Memberships**.
- New routes `app/(protected)/events/` and `app/(protected)/memberships/`.
- **Memberships** UI moves out of **Settings** into its own tab (list + create; already supports
  the nullable-venue scope). Leave a thin redirect from the old Settings location or remove it.

### Create-event flow
- The **Events** tab lists *all* the org's events (venue + standalone) with a **scope badge**, and
  hosts a top-level **"Create event"** action.
- Create form has a **scope toggle**: choose an existing venue **or** "No venue — enter address".
  The standalone path reveals address + map/coordinate picker + timezone fields.
- Onboarding already allows skipping venue creation; the dashboard/Events tab surfaces "Create
  event" without requiring a venue.

## Admin (`apps/admin`)

- Event review screens `leftJoin` the venue and render **org + standalone address** when the event
  is venue-less. Review actions (approve/reject) are unchanged and apply to both scopes.

## Booking

- Bookings reference `event_id`, so venue-less events book without change. **Verify** the booking
  creation path makes no implicit venue lookup; adjust the effective-location helper usage if it
  surfaces venue details on a confirmation/receipt.

## Implementation Phases

1. **Schema + API** — migration, Drizzle schema, `events_service`, new tenant-level create route,
   effective-location helper; audit existing event routes.
2. **Consumer** — `leftJoin` + effective-location projections, `GET /v1/consumer/events/:id`,
   unified `/events/[id]` page, `EventCard` re-link.
3. **Partners IA** — Events + Memberships top-level tabs; move Memberships out of Settings.
4. **Partners create-event** — scope-toggle create form + all-events list.
5. **Admin review** — `leftJoin` venue, render standalone address in review screens.

## Risks / Notes

- **Geocoding** for standalone addresses is best-effort; map pin absent until `lat`/`lng` exist.
  Geocoding implementation (which provider, sync vs async) is deferred — the schema tolerates null
  coords.
- **Effective-location helper** is the key seam; centralize it so api/consumer/admin don't each
  re-implement the venue-vs-event resolution.
- **Backfill:** existing events keep `venue_id`; new nullable columns default to `NULL` — no data
  migration needed.
