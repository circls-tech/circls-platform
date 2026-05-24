# Partner Portal — Core Matrix MVP (redesign + materialized slots)

> **Spec · 2026-05-24.** Slice 1 of the Partner Portal redesign. Status: design approved, pending spec review.
> Scope was deliberately cut to the "core matrix MVP"; deferred items are listed in §9.

## 1. Context

Backend is live at `api.circls.app` (Coolify + Postgres 18): `users`, `tenants`,
`tenant_members`, `venues`, `arenas`, `weekly_schedule`, `bookings` (tstzrange +
GIST exclusion), `pricing_rules`. The Partner Portal (`apps/partners`, Next.js 15)
has a working skeleton + basic reception screens, but it is visually bare and its
booking model (ad-hoc tstzrange bookings) does not match the desired slot-based
workflow. This slice **redesigns the portal** and **introduces a materialized-slot
model** that everything hangs off.

## 2. Goals (this slice)

- **Materialized slots:** concrete dated slots, each with its own price + status, released over a date window.
- **Schedule builder:** weekly matrix (days × time-slots), bulk edit price / block, then "Release".
- **Reception matrix:** view released slots, multi-select, add a walk-in booking (one booking over many slots), re-price / block unbooked slots, cancel.
- **Self sign-up + guided onboarding** (org → venue → arena → schedule).
- **Visual redesign:** left-sidebar app shell, clean card system, one accent color.
- **Safety:** DB-enforced no-overlap + no-double-book, confirmations on dangerous actions, soft-delete, an audit trail.

## 3. Non-goals (deferred — see §9)

Image upload (R2), tags → sport inference, full dashboard analytics, an audit-log
*viewer* UI, the `circls.app` consumer app, online payments, notifications.

## 4. Key decisions (locked in brainstorming)

1. **Slot model A — materialize** (not rules-derived). Each released slot is a concrete row.
2. **Default price = `pricing_rules`** resolved at release time, then per-cell overridable.
3. **Tentative holds:** a slot may be `held` briefly during booking; expired holds are treated as open (no background worker this slice — see §7).
4. **Multi-slot bookings:** one booking covers many selected slots (one customer / reservation).
5. **Matrix UX = grid + right inspector** panel (selection-driven actions).
6. **App shell = left sidebar.**
7. **Auth = phone-OTP** (unchanged); on first login with no tenant, prompt org creation.

## 5. Data model

### 5.1 `slots` (new) — the materialized grid

| column | type | notes |
|---|---|---|
| `id` | uuid PK | `uuidv7()` |
| `tenant_id` | uuid FK→tenants | denormalized for scoping |
| `arena_id` | uuid FK→arenas | |
| `time_range` | `tstzrange` | the concrete dated slot |
| `price_paise` | bigint | per-slot price (₹×100) |
| `status` | enum `slot_status` | `open` \| `held` \| `blocked` \| `booked` |
| `hold_expires_at` | timestamptz null | set when `held` |
| `booking_id` | uuid FK→bookings null | set when `booked` |
| `release_id` | uuid FK→slot_releases null | which release created it |
| `deleted_at` | timestamptz null | soft-delete |
| `created_at` / `updated_at` | timestamptz | |

Constraints / indexes:
- `EXCLUDE USING gist (arena_id WITH =, time_range WITH &&) WHERE (deleted_at IS NULL)` — no two live slots overlap on an arena (so re-release can't duplicate).
- index `(arena_id, time_range)` for matrix range queries; index `(tenant_id)`.
- Needs `btree_gist` (already enabled by migration `0003`).

### 5.2 `slot_releases` (new) — audit of each release

`id, tenant_id, arena_id, start_date, end_date, quantization_min, default_source ('rules'|'flat'), created_by_user_id, created_at`. One row per "Release" action; slots point back via `release_id`.

### 5.3 `bookings` (extend existing)

A booking covers **many** slots. Add: `customer_name text`, `customer_contact text`, `note text null`, `total_paise bigint` (= Σ booked slot prices at booking time). Keep `channel='walkin'`, `payment_method='external'`, `status`. The slot→booking link lives on `slots.booking_id`. The legacy single-`time_range` columns on `bookings` are retained but unused for slot bookings (a slot booking's intervals live on its slots).

### 5.4 `weekly_schedule` (role: the template)

Reused as the recurring template the builder edits before release (`day_of_week, start_time, end_time, slot_duration_min`). The builder may also carry transient per-cell overrides in the request payload (not persisted separately — they go straight into materialized slots at release).

### 5.5 `audit_log` (new, lightweight)

`id, tenant_id, actor_user_id, action (text), entity_type, entity_id, before jsonb null, after jsonb null, created_at`. A row is written for: slot re-price, slot block/unblock, booking create, booking cancel. **No viewer UI this slice** — the trail is written for later. Deletes are soft (`deleted_at`), never hard.

### 5.6 `pricing_rules` (role change)

No longer resolved per-booking. Now the **default-price source at release**: `resolvePricePaise(arena, slotStart, channel)` seeds each new slot's `price_paise`; the builder shows those defaults and lets the owner override per cell.

### 5.7 Migrations

`0006_slots` (enum + `slots` + `slot_releases` + exclusion constraint), `0007_bookings_slots_audit` (`bookings` new columns + `audit_log`). Drizzle-kit generate, hand-add the `EXCLUDE` constraint (as in `0003`).

## 6. API (all tenant-scoped via `requireTenantMembership`)

- **`PUT /v1/arenas/:id/schedule-template`** — save the weekly template.
- **`POST /v1/arenas/:id/slots/release`** `{ startDate, endDate, quantizationMin, cells:[{dayOfWeek,startTime,price?,blocked?}] }` → materializes slots across the window. Default price from `pricing_rules` unless a per-cell `price` is given. **Idempotency-Key required.** Overlapping existing live slots are skipped (the exclusion constraint guards; report counts created/skipped).
- **`GET /v1/arenas/:id/slots?from&to`** → slot rows for the matrix (excludes `deleted_at`).
- **`PATCH /v1/slots/bulk`** `{ slotIds[], price?|blocked? }` → re-price / block. **Guard: only `open` slots** (booked/held → `409 slot_locked`); writes `audit_log`. Re-price changes nothing on other releases (slots are independent rows).
- **`POST /v1/bookings`** `{ slotIds[], customer:{name,contact,note?} }` → **atomic multi-slot**:
  `UPDATE slots SET status='booked', booking_id=$b WHERE id = ANY($slotIds) AND (status='open' OR (status='held' AND hold_expires_at < now())) AND deleted_at IS NULL` inside a tx that first inserts the booking; if `rowCount ≠ slotIds.length` → rollback → `409 slot_taken`. Idempotency-Key required. Total = Σ slot prices.
- **`POST /v1/slots/hold`** `{ slotIds[] }` → set `held` + `hold_expires_at = now()+5m` on open slots (best-effort; used when the booking modal opens). **`POST /v1/slots/release-hold`** `{ slotIds[] }` → back to `open`.
- **`POST /v1/bookings/:id/cancel`** → confirm-gated client-side; sets booking cancelled, frees its slots (`status='open', booking_id=null`), writes `audit_log`.

Error codes: `slot_taken`, `slot_locked`, `tenant_forbidden`, `bad_request`, `idempotency_key_required`.

## 7. Concurrency & safety

- **No overlapping slots:** `slots` GIST exclusion.
- **No double-book (incl. multi-slot):** single atomic conditional `UPDATE`; partial success rolls back → `slot_taken`.
- **Holds without a worker:** there is no pg-boss yet. Expired holds are treated as bookable directly in the booking `UPDATE` predicate (above), and the matrix `GET` reports `held & expired` as `open`. A proper sweep job is deferred to the worker phase. *(Explicit simplification — no dependency on un-built infra.)*
- **Re-price guard:** open-only; booked/held rejected.
- **Confirmations:** client-side modal before cancel and before changing a slot that affects money.
- **Soft-delete + audit:** `deleted_at` everywhere destructive; `audit_log` row on every money/booking mutation.

## 8. Frontend (`apps/partners`, redesigned)

- **Shell:** left sidebar (Dashboard · Venues · Bookings · Settings), org/venue switcher in the top bar, clean card components, single accent. A small design-token layer (colors, spacing, radius) in `globals.css` / a `ui/` folder of primitives (Button, Card, Input, Modal, Matrix).
- **Auth + onboarding:** phone-OTP (unchanged) → if `useMyTenants()` empty, route to **Create organization** → guided optional steps: add venue → add arena → set schedule. Steps skippable; progress shown.
- **Schedule builder** (`/arenas/[id]/schedule`): window + quantization + default → preview **Matrix** (grid + inspector) → drag-select cells / click day or time headers for whole column/row → bulk set price / block via inspector → **Save = Release** (calls `/slots/release`).
- **Reception matrix** (`/venues/[id]` → arena, and `/arenas/[id]`): same Matrix over released slots (week pager). Select cell(s) → inspector → **Add Booking** modal (name / contact / optional note) → `POST /v1/bookings`. Re-price / block unbooked from the inspector. Cancel from a booked cell (confirm).
- **Matrix component:** one reusable `<Matrix>` (days × times, color states open/held/blocked/booked/selected, week pager) used by both builder and reception; mode prop switches available actions.
- **Dashboard:** redesigned shell + placeholder stat cards (bookings today / revenue / occupancy) — real numbers are a later slice.

## 9. Deferred (later slices)

Image upload (R2) · tags → sport inference · full analytics · audit-log viewer UI · `circls.app` consumer app + online payments + notifications · pg-boss worker (incl. proper hold-sweep).

## 10. Testing

- **Backend (vitest + local PG, as established):** release materializes N slots with rule-seeded prices; bulk re-price guarded to open; **multi-slot booking atomic** (concurrent → exactly one wins, other `slot_taken`); cancel frees slots; `audit_log` rows written; tenancy isolation on every new route.
- **Frontend:** `next build` + typecheck clean; manual QA checklist (login → onboarding → schedule → release → book → cancel). Login/visual QA needs a browser + Firebase authorized domains.

## 11. Build order (within the slice)

1. Backend: `slots` + `slot_releases` + `audit_log` + bookings alter + migrations + services + routes + tests.
2. Frontend foundation: shell redesign + design primitives + onboarding/self-signup.
3. `<Matrix>` component + schedule builder (release).
4. Reception matrix + Add Booking modal + cancel + confirmations.
5. Dashboard shell + placeholder stats. Commit per step.
