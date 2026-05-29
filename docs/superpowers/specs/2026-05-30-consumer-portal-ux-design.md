# Consumer Portal UX Redesign — "Premium Club" — Design Spec

**Date:** 2026-05-30
**App:** `apps/consumer` (circls.app)
**Status:** Approved for planning

## 1. Goal & Context

The consumer portal works but reads as generic: system fonts, a single flat
blue, and plain bordered cards with no imagery. This redesign gives it a
distinctive, premium identity ("a little jest, a few good cards and fonts")
without changing any backend, data model, or business logic. It is a
**frontend-only visual redesign** of the four existing pages plus the header.

The chosen direction (from a visual brainstorm) is **"Premium Club"**: deep navy
+ warm gold, an elegant serif for headings over a clean sans for body/UI. It
feels aspirational and members-club, photographs well, and ages slowly.

## 2. Scope

**In scope** — restyle of every existing surface in `apps/consumer`:

- Header / wordmark
- Home page (`app/page.tsx`) — hero + venue search grid
- Venue detail (`app/venues/[venueId]/page.tsx`) — hero banner, arenas/slots,
  events, memberships
- My bookings (`app/me/bookings/page.tsx`)
- Login (`app/login/page.tsx`)
- Shared UI primitives in `lib/ui/` (Button, Card, Badge, Input) + design tokens
  in `app/globals.css`
- A new **tag → sport image** system with the court-line motif as fallback

**Out of scope (explicitly deferred):**

- Backend image upload, file storage, and partner-portal changes. The frontend
  is built **forward-compatible** with an eventual `imageUrl` on a venue (see
  §6), but the API will not populate it yet and no backend work happens here.
- Search/filter logic, routing, auth flow, payment/checkout logic, new pages.
- Any change to `apps/api`.

## 3. Design Tokens

Defined in `app/globals.css` under Tailwind v4 `@theme` (replacing the current
blue/slate brand scale). Fonts loaded via `next/font/google` for zero layout
shift and self-hosting.

**Typography**

- Display / headings: **Fraunces** (serif), weights 500–700. Exposed as
  `--font-display`, used for the wordmark, page `h1`/`h2`, venue & card names.
- Body / UI: **Inter** (sans), weights 400–700. Exposed as `--font-sans`, the
  default `body` font. Replaces the current system font stack.

**Color**

| Token | Hex | Use |
|---|---|---|
| `--color-ink` | `#0f1c2e` | Primary navy — headers, primary buttons, text on light |
| `--color-ink-deep` | `#0b1424` | Gradient end, deepest navy |
| `--color-ink-soft` | `#1e3a5f` | Gradient mid / hover |
| `--color-gold-500` | `#e7c87d` | Accent — wordmark, CTA fills, motif lines |
| `--color-gold-600` | `#c79a3a` | Gold hover / deeper accent |
| `--color-gold-100` | `#f3ead3` | Tag/badge fill |
| `--color-gold-text` | `#7a5b1e` | Text on gold-100 fills (passes contrast) |
| `--color-surface` | `#fbf9f4` | Warm off-white page background |
| `--color-surface-card` | `#ffffff` | Card background |
| `--color-border` | `#ece3d0` | Warm card/hairline border |
| `--color-text-primary` | `#0f1c2e` | Primary text |
| `--color-text-secondary` | `#64748b` | Secondary/meta text |
| `--color-text-muted` | `#94a3b8` | Muted/placeholder |

Existing booking **status tones** (open/held/booked/success/warning/danger) are
retained for functional clarity; only neutral/brand tones are reskinned.

**Contrast rule:** gold is used only as a *fill behind dark text* (gold-100 +
gold-text) or *as text/lines on navy* (gold-500 on ink). Gold text on white is
disallowed — it fails contrast.

**Shape**

- `--radius` stays `0.5rem` (8px) for buttons/inputs/chips.
- New `--radius-card: 1rem` (16px) for cards and image headers.

## 4. Component Changes (`lib/ui/`)

- **Button** — add a `accent` (gold fill, navy text) variant for primary CTAs
  where we want pop; `primary` becomes navy (`--color-ink`) fill, white text;
  `secondary`/`ghost` reskinned to warm neutrals. Keep existing API
  (`variant`, `size`, `loading`).
- **Badge** — add/repoint a `sport` tone (gold-100 fill, gold-text). Used for
  tags.
- **Card** — keep the primitive; bump radius to `--radius-card`, warm border,
  softer shadow. Hover lift (translate + shadow) added where cards are clickable.
- **Input** — warm border, gold focus ring (via existing `:focus-visible`).
- A new **`VenueCard`** composition (in `components/` or `lib/ui/`) renders the
  image header (or motif), sport label, serif name, meta line, and tags. Used on
  the home grid.
- A new **`SportImage`** component renders the resolved image with the navy
  gradient scrim + sport label, or the court-line motif when there is no photo.

## 5. Tag → Sport Image System

A new module `lib/sportImages.ts`:

- `SPORT_IMAGES: Record<CanonicalSport, string>` — maps a canonical sport key to
  a **self-hosted** asset path under `public/sports/`.
- Curated, verified images for **12 sports**: badminton, tennis, football
  (turf), cricket, basketball, swimming, table tennis, squash, gym, **pickleball,
  bouldering, running** (last three client-requested).
- `SPORT_ALIASES: Record<string, CanonicalSport>` — folds real-world variants to
  canonical keys: `soccer`/`5-a-side`/`futsal` → football, `climbing` →
  bouldering, `marathon`/`jogging`/`track` → running, `tt`/`ping pong` → table
  tennis, etc.
- `resolveVenueImage(input): { kind: 'photo'; src: string; sport: CanonicalSport }
  | { kind: 'motif'; sport?: string }`

**Resolution order** (highest priority first):

1. `input.imageUrl` — an uploaded photo (future backend; see §6). If present,
   `{ kind: 'photo', src: imageUrl }`.
2. First entry in `input.tags` whose **normalized** form (lowercased, trimmed,
   non-alphanumerics stripped) matches a `SPORT_IMAGES` key directly or via
   `SPORT_ALIASES` → `{ kind: 'photo', src: SPORT_IMAGES[sport] }`.
3. Otherwise `{ kind: 'motif' }` — the court-line motif fallback.

**Assets:** the 12 images are downloaded from Unsplash (free Unsplash License,
no attribution required) into `apps/consumer/public/sports/<sport>.jpg`,
optimized to ~800px wide. A `public/sports/SOURCES.md` records each source URL +
license note. Self-hosting means a slow/blocked external CDN never blanks a card.

## 6. Forward-Compatibility with Backend Uploads (deferred)

When file storage + partner-portal uploads land later, the API will add an
optional `imageUrl` to the public venue payload. To make that a drop-in:

- `PublicVenue` in `lib/api/types.ts` gains an optional `imageUrl?: string | null`
  now (harmless; API returns `undefined` until implemented).
- `resolveVenueImage` already prefers `imageUrl` (step 1). When the backend
  starts sending it, uploaded photos appear automatically, still falling back to
  the tag-matched image, then the motif. **No frontend change required at that
  point.**

## 7. Page-by-Page Treatment

- **Header** — navy bar, gold "cir**cls**" Fraunces wordmark, gold accent on the
  primary auth CTA. Same nav structure.
- **Home** — navy header; serif `h1` hero ("Find your game") + subtitle + rounded
  search field; responsive `VenueCard` grid (photo/motif). Loading → skeleton
  shimmer cards (not "Loading…" text). Empty → motif graphic + friendly line.
- **Venue detail** — full-width **hero banner** using the venue's resolved image
  (scrim + serif venue name + tags overlaid); motif banner when no photo. Then
  the existing three sections, restyled: arena slot chips get gold hover; event
  and membership cards use the premium card style; membership cards get a gold
  accent. Checkout banner restyled to the new tones.
- **My bookings** — restyled booking rows/cards with serif venue name and status
  pills; friendly empty state.
- **Login** — centered premium card on the warm/navy background, serif heading.

## 8. "Jest" / Delight (tasteful, not noisy)

- Card hover: lift (`translateY(-3px)`) + soft shadow.
- Gold underline grow on text links.
- Skeleton shimmer loaders replace text "Loading…" states.
- Friendly empty states reusing the court-line motif + one line of copy.
- Subtle staggered fade-in on the venue grid.
- Booking success: gold-accented confirmation banner.

All motion respects `prefers-reduced-motion` (disable transforms/fades).

## 9. Accessibility

- Every venue image has descriptive `alt` (e.g. "Badminton court at Smash Arena").
- Gradient scrim guarantees white sport-label legibility over any photo.
- Color usage follows the contrast rule in §3.
- Existing `:focus-visible` ring retained (recolored to gold-on-navy / navy ring).
- Motion gated behind `prefers-reduced-motion`.

## 10. Testing

- **Unit:** `lib/sportImages.test.ts` — `resolveVenueImage` covers direct match,
  alias match, normalization (case/whitespace/punctuation), `imageUrl` precedence,
  and motif fallback when no tag matches.
- **Build/typecheck:** `pnpm` build of `apps/consumer` passes; `PublicVenue` type
  change compiles.
- **Manual visual pass:** each of the four pages in loading / populated / empty
  states; a venue with a matching tag (photo) and one without (motif); reduced-
  motion on.
- Existing `apps/api` tests are untouched and must still pass.

## 11. Risks & Notes

- **Tag coverage:** if partner tags are messy, more venues fall to the motif.
  The alias table mitigates this; the motif is designed to look intentional, so
  a miss is graceful rather than broken.
- **Image licensing:** all assets are Unsplash-License; `SOURCES.md` documents
  provenance.
- **Bundle size:** 12 optimized ~800px JPEGs (self-hosted) — modest; served as
  static assets, lazy-loaded below the fold.
