# Consumer Portal UX Redesign — "Premium Club" — Design Spec

**Date:** 2026-05-30
**App:** `apps/consumer` (circls.app)
**Status:** Approved for planning

## 1. Goal & Context

The consumer portal works but reads as generic: system fonts, a single flat
blue, plain bordered cards, no imagery, and only a bare venue-search home page.
This effort gives it a distinctive premium identity **and** expands it from a
single page into a real first-visit experience: a marketing landing page,
dedicated venues and events listing pages, and the company's legal pages.

The chosen visual direction (from a visual brainstorm) is **"Premium Club"**:
deep navy + warm gold, an elegant serif (**Fraunces**) for headings over a clean
sans (**Inter**) for body/UI. It feels aspirational and members-club, photographs
well, and ages slowly.

This is primarily a **frontend** effort. A handful of **API changes are required**
(§12); those are described precisely here and will be implemented by a separate
agent — no API code is written as part of this spec's plan beyond the frontend's
consumption of it.

## 2. Scope

**In scope (frontend, `apps/consumer`):**

- Visual redesign tokens + primitives (fonts, color, cards, buttons, badges).
- **Route reshuffle + new pages** (§3): landing `/`, venues `/venues`, events
  `/events`, legal `/privacy` `/terms` `/refund`, plus a site-wide footer.
- Restyle of existing surfaces: venue detail, my bookings, login, header.
- The **tag → sport image** system with the court-line motif fallback (§5–6).

**In scope (API, handed off — §12):**

- Filter venue listings to those with a bookable arena.
- Hide past events everywhere; sort events by start time ascending.
- Two new cross-venue browse endpoints (all upcoming events; all memberships).

**Out of scope (explicitly deferred):**

- Backend **image upload** + file storage + partner-portal upload UI. The
  frontend is built forward-compatible with an eventual venue `imageUrl` (§6),
  but no backend image work happens now.
- A standalone memberships listing page (decided against — memberships surface
  on the landing row + venue detail).
- Auth flow, payment/checkout logic, any new business rules.

## 3. Information Architecture & Routes

| Route | Status | Purpose |
|---|---|---|
| `/` | **changed** | **Landing page** — hero + 3 horizontal-scroll rows (§8) |
| `/venues` | **new** | **Venues listing** — searchable grid (today's home grid, moved here) (§9) |
| `/events` | **new** | **Events listing** — all venues, upcoming only, ascending (§10) |
| `/venues/[venueId]` | restyle | Venue detail — arenas (book), events (join), memberships (buy) |
| `/me/bookings` | restyle | My bookings |
| `/login` | restyle | Sign in |
| `/privacy`, `/terms`, `/refund` | **new** | Legal pages (§11) |
| site-wide footer | **new** | Nav + legal links + © line (§11) |

Header nav gains **Venues** and **Events** links. The home grid logic currently
in `app/page.tsx` moves to `app/venues/page.tsx`; `app/page.tsx` becomes the
landing page.

## 4. Design Tokens

Defined in `app/globals.css` under Tailwind v4 `@theme` (replacing the current
blue/slate scale). Fonts via `next/font/google` (zero layout shift, self-hosted).

**Typography**

- Display / headings: **Fraunces** (serif), 500–700 → `--font-display`. Wordmark,
  page `h1`/`h2`, venue/event/membership names.
- Body / UI: **Inter** (sans), 400–700 → `--font-sans`. Default `body` font.

**Color**

| Token | Hex | Use |
|---|---|---|
| `--color-ink` | `#0f1c2e` | Primary navy — headers, primary buttons, text |
| `--color-ink-deep` | `#0b1424` | Gradient end / footer |
| `--color-ink-soft` | `#1e3a5f` | Gradient mid / hover |
| `--color-gold-500` | `#e7c87d` | Accent — wordmark, CTA fills, motif lines |
| `--color-gold-600` | `#c79a3a` | Gold hover / "View all" links |
| `--color-gold-100` | `#f3ead3` | Tag/badge fill |
| `--color-gold-text` | `#7a5b1e` | Text on gold-100 (passes contrast) |
| `--color-surface` | `#fbf9f4` | Warm off-white page background |
| `--color-surface-card` | `#ffffff` | Card background |
| `--color-border` | `#ece3d0` | Warm card/hairline border |
| `--color-text-primary` | `#0f1c2e` | Primary text |
| `--color-text-secondary` | `#64748b` | Secondary/meta |
| `--color-text-muted` | `#94a3b8` | Muted/placeholder |

Existing booking **status tones** are retained for functional clarity; only
neutral/brand tones are reskinned.

**Contrast rule:** gold is used only as a *fill behind dark text* (gold-100 +
gold-text) or *as text/lines on navy* (gold-500 on ink). Gold text on white is
disallowed — fails contrast.

**Shape:** `--radius` stays `0.5rem` (8px) for buttons/inputs/chips; new
`--radius-card: 1rem` (16px) for cards and image headers.

## 5. Component Changes (`lib/ui/` + `components/`)

- **Button** — `accent` (gold fill, navy text) for hero/primary CTAs; `primary`
  becomes navy fill / white text; `secondary`/`ghost` reskinned to warm neutrals.
  Existing API (`variant`, `size`, `loading`) preserved.
- **Badge** — `sport` tone (gold-100 fill, gold-text) for tags.
- **Card** — `--radius-card`, warm border, softer shadow; hover lift where clickable.
- **Input** — warm border, gold focus ring.
- **`SportImage`** (new) — renders the resolved photo with navy gradient scrim +
  sport label, or the court-line motif when no photo.
- **`VenueCard`**, **`EventCard`**, **`MembershipCard`** (new compositions) — used
  by the landing rows and listing pages. EventCard shows a gold date badge;
  MembershipCard is an inverted navy/gold "premium product" card.
- **`Footer`** (new) — site-wide (§11).
- **`HScroll`** (new) — horizontal scroll-snap row with peeking next card, used by
  the three landing rows.

## 6. Tag → Sport Image System

New module `lib/sportImages.ts`:

- `SPORT_IMAGES: Record<CanonicalSport, string>` — canonical sport → **self-hosted**
  asset under `public/sports/`.
- Curated, verified images for **12 sports**: badminton, tennis, football (turf),
  cricket, basketball, swimming, table tennis, squash, gym, **pickleball,
  bouldering, running** (last three client-requested). Verified Unsplash source
  URLs are recorded in `public/sports/SOURCES.md`.
- `SPORT_ALIASES: Record<string, CanonicalSport>` — folds variants: `soccer` /
  `5-a-side` / `futsal` → football, `climbing` → bouldering, `marathon` /
  `jogging` / `track` → running, `tt` / `ping pong` → table tennis, etc.
- `resolveImage(input): { kind:'photo'; src; sport } | { kind:'motif'; sport? }`
  where `input = { imageUrl?: string|null; tags: string[] }`.

**Resolution order:** (1) `imageUrl` (future upload) → photo; (2) first tag whose
**normalized** form (lowercase, trim, strip non-alphanumerics) matches a key
directly or via alias → photo; (3) otherwise → **motif**.

Used by venue cards (venue tags), event cards (**owning venue's tags** — events
have no tags), and membership cards (venue tags; tenant-wide → motif).

**Assets:** the 12 images are downloaded into `apps/consumer/public/sports/<sport>.jpg`,
optimized ~800px wide. Self-hosting means a slow/blocked CDN never blanks a card.

## 7. Forward-Compatibility with Backend Uploads (deferred)

`PublicVenue` in `lib/api/types.ts` gains optional `imageUrl?: string | null`
now (harmless; API returns `undefined` until implemented). `resolveImage` already
prefers it (step 1), so when upload + storage ship later, photos appear with **no
frontend change** — still falling back to tag image, then motif.

## 8. Landing Page (`/`)

For first-time visitors; conveys the product and surfaces live inventory.

- **Hero** — navy gradient with a faint court-line texture; gold eyebrow
  ("Welcome to Circls"), serif headline (**"Find your circle. Book your spot."**
  with "Book your spot." in gold), and subline **"Because 'we should do this
  sometime' deserves an actual time."**, plus two CTAs (`accent` "Browse venues" →
  `/venues`; ghost "See what's on →" → `/events`). Copy is deliberately
  category-agnostic (no "sports/courts/booking" in the message) so it survives
  Circls generalizing beyond sports later — the headline carries the "what", the
  subline the "why".
- **Three horizontal-scroll rows** (`HScroll`), each with a section heading and a
  gold "View all →", and **each hidden entirely if its data array is empty**:
  1. **Venues near you** → `VenueCard`s — `GET /venues?limit=10` → "View all" `/venues`.
  2. **Upcoming events** → `EventCard`s — `GET /events?limit=10` → "View all" `/events`.
  3. **Memberships** → `MembershipCard`s — `GET /memberships?limit=10`. **No "View
     all"** (no listing page); each card links to its owning venue detail.
- **Footer** (§11).

Loading → skeleton rows; if all three are empty → a friendly motif + a single CTA
to browse venues.

## 9. Venues Listing Page (`/venues`)

Today's `app/page.tsx` grid logic, moved and restyled. Serif page title + search
field + responsive `VenueCard` grid (photo/motif). Shows **only venues with a
bookable arena** (§12.1). Loading → skeleton cards; empty → friendly motif state.
Each card → `/venues/[venueId]`.

## 10. Events Listing Page (`/events`)

All events across all venues, **upcoming only**, **sorted by start time ascending**
(§12.2–12.3). Backed by `GET /events`. Rendered as `EventCard`s, optionally
grouped by day with a serif date divider (e.g. "Saturday, 14 Jun"). Each card
shows event name, owning venue, time, price, and links to the owning venue detail
(where the booking action lives). **Past events are never shown** — enforced
server-side and guarded client-side.

## 11. Legal Pages + Footer

Port the three policy screens from the sibling Flutter web app into Next.js
routes, reproducing the text **verbatim** in the Premium Club style.

**Source files (read-only reference, `~/personal/circls/apps/circls_web/lib/src/`):**

- Privacy → `screens/privacy/privacy_screen.dart` (`/privacy`, 15 sections, 4 group labels)
- Terms → `screens/terms/terms_screen.dart` (`/terms`, 20 sections, 7 group labels;
  Section 20 = merchant info)
- Refund → `screens/refund/refund_screen.dart` (`/refund`, 7 sections + an
  **eligibility grid** + a **refund timeline row** — port both as styled components)
- Shared widgets to mirror → `widgets/legal/policy_section.dart` (page header,
  intro box, section group labels, numbered sections, inter-page nav tabs)
- Footer → `widgets/footer.dart`

**Legal facts to bake in (all pages "Last updated 12 May 2026"):**

- Entity: **Gibbous Technologies Private Limited**
- GSTIN: **27AALCG2506R1Z3**
- Registered office (Pune): Floor 2, 102 MPJ Chambers, Mumbai Pune Road,
  Wakdewali, Pune, Maharashtra 411003
- Additional office (Nagpur): Ground Floor, 16 Megh Apartment, Gajanan Mandir
  Road, Dharampeth, Nagpur, Maharashtra 440010
- Jurisdiction: Nagpur, Maharashtra, India
- Legal/data/refund contact: **Contact@gibbous.io**; support: **support@gibbous.io**
- Copyright line: **© 2026 Gibbous.io. All rights reserved.**

**Components:** a `LegalLayout` (brand line "CIRCLS · GIBBOUS TECHNOLOGIES PRIVATE
LIMITED", page title, last-updated + contact + jurisdiction meta, intro box,
section groups, inter-page nav tabs, contact card at the bottom). Content stored
as structured TS data (mirroring the Dart `_Section` model) — not raw HTML — so it
stays typed and easy to amend.

**Footer** (`components/Footer.tsx`, on every page): navy; brand wordmark; columns
of links (Venues, Events, Privacy Policy, Terms & Conditions, Refund Policy,
Contact `mailto:support@gibbous.io`); a bottom legal line with the copyright +
entity + GSTIN + city + support email.

## 12. Required API Changes (handoff to API agent)

All in `apps/api/src/services/consumer_service.ts` + `routes/consumer.ts`. The
existing **approval + tenant-active** visibility rule must hold for every new
read (approved venue/listing AND non-suspended tenant).

**12.1 — Venues must have a bookable arena.**
In `listPublicVenues`, add a condition that the venue has ≥1 arena with
`status='active'`:
```
exists (select 1 from arenas a where a.venue_id = venues.id and a.status = 'active')
```
Affects the landing venues row and `/venues`. `getPublicVenue` (single, used by
venue detail) is unchanged.

**12.2 — Hide past events + sort, per venue.**
In `listPublicEvents(venueId)`, add `events.ends_at >= now()` and
`order by events.starts_at asc`. (Drives the venue-detail events section.)

**12.3 — New: all upcoming events across venues.**
New service `listPublicUpcomingEvents({ limit? })` + route
`GET /v1/consumer/events?limit=`:
- Join `venues` + `tenants`; filter `events.status='published'`,
  `venues.status='active'`, `tenants.status='active'`, `events.ends_at >= now()`.
- `order by events.starts_at asc`, `limit` (default ~50, max 100; landing passes 10).
- Return each event's existing public fields **plus `venueName` and
  `venueTags: string[]`** (needed for the card image + venue label).

**12.4 — New: all memberships across venues.**
New service `listPublicMembershipsAcrossVenues({ limit? })` + route
`GET /v1/consumer/memberships?limit=`:
- Filter `memberships.status='active'` AND owning `tenants.status='active'`; if
  `venue_id` is set, that venue must be `status='active'`.
- Return each membership's existing public fields **plus `venueId` (nullable),
  `scopeName`** (the venue name, or the tenant/brand name for tenant-wide
  memberships) **and `venueTags: string[]`** (empty for tenant-wide → card uses
  motif). `limit` default ~50, max 100; landing passes 10.

**Frontend type additions** (`apps/consumer/lib/api/types.ts`): `imageUrl?` on
`PublicVenue` (§7); `PublicEventWithVenue` (event + `venueName` + `venueTags`);
`PublicMembershipWithScope` (membership + `venueId` + `scopeName` + `venueTags`).
New hooks in `lib/api/consumer.ts`: `useUpcomingEvents(limit?)`,
`useAllMemberships(limit?)`.

## 13. "Jest" / Delight (tasteful, not noisy)

- Card hover lift + soft shadow; gold underline grow on text links.
- Horizontal scroll-snap rows with a peeking next card.
- Skeleton shimmer loaders replace text "Loading…" states.
- Friendly empty states reusing the court-line motif + one line of copy.
- Subtle staggered fade-in on grids/rows; gold-accented booking-success banner.
- All motion gated behind `prefers-reduced-motion`.

## 14. Accessibility

- Descriptive `alt` on every image (e.g. "Badminton court at Smash Arena").
- Gradient scrim guarantees white sport-label legibility over any photo.
- Color usage follows the §4 contrast rule.
- `:focus-visible` ring retained (gold-on-navy / navy ring).
- Horizontal scrollers are keyboard-scrollable; "View all" gives a non-scroll path.
- Motion gated behind `prefers-reduced-motion`.

## 15. Testing

- **Unit:** `lib/sportImages.test.ts` — `resolveImage` covers direct match, alias
  match, normalization, `imageUrl` precedence, and motif fallback.
- **Build/typecheck:** `apps/consumer` builds; new types compile.
- **Manual visual pass:** landing (populated + all-empty), venues (populated +
  empty), events (populated + empty + a past event that must NOT appear), venue
  detail, my bookings, login, and all three legal pages; reduced-motion on.
- **API (by the API agent):** unit tests for the arena-filter, past-event hiding +
  ordering, and the two new cross-venue endpoints (visibility filtering + shape).
- Existing `apps/api` consumer tests must still pass.

## 16. Risks & Notes

- **Tag coverage:** messy partner tags push more venues to the motif; the alias
  table mitigates, and the motif is designed to look intentional.
- **Legal text fidelity:** reproduce verbatim from the Dart sources; do not
  paraphrase. Keep the "Last updated 12 May 2026" dates unless told otherwise.
- **Image licensing:** all assets are Unsplash-License; `SOURCES.md` documents
  provenance.
- **Tenant-wide membership labeling:** requires exposing the tenant/brand name in
  the memberships endpoint (§12.4) — minor public-data addition.
