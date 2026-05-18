# Circls — System Architecture

> Tech stack and repository structure locked **2026-05-18**. Data-model column shape + ORM locked **2026-05-19**. See the *Tech stack*, *Repository structure*, and *Schema decisions* sections below. This document captures the system design (entities, boundaries, data flows, locked tooling). Specific endpoint contracts, UX flows, and revenue model are out of scope and live elsewhere.

## High-level shape

Five user-facing surfaces consume one Core Platform via its API. The Core Platform is the only thing that touches the database, external payment systems, notification gateways, and webhook partners.

```
                      ┌──────────────────────────────────────────────────────┐
                      │                  Core Platform                        │
                      │  (data + business rules + integrations + workers)     │
                      └────┬───────┬───────┬───────────┬──────────────┬──────┘
                           │       │       │           │              │
                           ▼       ▼       ▼           ▼              ▼
                     ┌─────────┐ ┌─────┐ ┌──────┐ ┌─────────┐ ┌──────────────┐
                     │ Partner │ │Cons-│ │Admin │ │ Mobile  │ │ Integration  │
                     │ Portal  │ │umer │ │Cons- │ │  (P1,   │ │   Surface    │
                     │         │ │ App │ │ ole  │ │  later) │ │ (3rd parties)│
                     └─────────┘ └─────┘ └──────┘ └─────────┘ └──────────────┘
```

No portal talks to another portal. No portal talks to the database. All cross-portal coordination happens through Core.

## Tech stack

| Layer | Technology | Notes |
|---|---|---|
| **Backend** | Node.js + **Fastify** (TypeScript) | Serves all frontends + Integration Surface via one typed HTTP API. |
| **Database** | **PostgreSQL** on **Neon** | Serverless, scale-to-zero, branching for staging. ACID transactions back the inventory invariant. |
| **ORM / query layer** | **Drizzle** (TypeScript) | SQL-honest, fast runtime, type-safe; pairs naturally with Fastify. App-layer tenancy enforced through a typed `withTenant(ctx, db)` wrapper. |
| **Job queue** | **pg-boss** | Postgres-native; no Redis required. Upgrade path to BullMQ + Upstash if we outgrow it. |
| **Authentication** | **Firebase Auth** (Firebase Auth *only* — no other Firebase services) | Phone OTP for consumers + partners; email/password for admins. Backend verifies JWTs via `firebase-admin`. |
| **Image / asset storage** | **Cloudflare R2** | S3-compatible API, zero egress fees, easy CDN integration. |
| **Consumer app** (`circls.app`) | **Flutter web** (existing codebase, largely rewritten against the new backend) | Path to mobile reuse later. |
| **Partner Portal** (`partners.circls.app`) | **Next.js** (App Router) | Consumes the backend API; no business logic in `app/api/*` routes. |
| **Admin Console** (`admin.circls.app`) | **Next.js** (App Router) | Same shape as Partner Portal. |
| **Backend deploy** | **Fly.io** (`bom` region — Mumbai) | Persistent workers; low India latency. |
| **Next.js deploy** | **Vercel** | Both Next.js apps. |
| **Flutter web deploy** | **Cloudflare Pages** | Keeps Firebase footprint to Auth only. |

### Design implications of this stack

- **Same business logic everywhere.** The Fastify backend is the single source of truth. The Next.js portals and the Flutter app are thin frontends calling its endpoints. **No `app/api/*` route in Next.js carries business logic** — Next.js handles UI, routing, and at most thin BFF concerns (e.g., file-upload presigning if needed).
- **Workers share the backend codebase.** A second entry point in `apps/api` runs as a worker process on Fly.io, sharing models, services, and DB-connection logic with the API server. No code duplication.
- **Strong types across the JS boundary.** The Fastify backend defines the API contract in TypeScript; both Next.js apps consume the same `packages/api-types`. Contract changes surface as compile errors immediately.
- **Flutter ↔ backend uses an OpenAPI contract.** The backend emits an OpenAPI spec; Flutter consumes it via Dart codegen, not hand-written types.

## Repository structure

Two repositories — JS monorepo + Flutter polyrepo.

### `circls-platform/` — JS monorepo (pnpm workspaces)

```
circls-platform/
├── apps/
│   ├── api/                  Fastify backend + worker (single codebase, two entry points)
│   ├── admin/                Next.js — admin.circls.app
│   └── partners/             Next.js — partners.circls.app
├── packages/
│   ├── api-types/            Shared TypeScript types for the API contract
│   ├── ui-kit/               Shared React components (Tailwind)
│   └── config/               Shared eslint, prettier, tsconfig
├── pnpm-workspace.yaml
└── package.json
```

### `circls-flutter/` — separate repo

The existing Flutter consumer app (and future mobile). Has its own pubspec + CI. Consumes the backend via an OpenAPI-generated Dart client.

### Why this split

- **Within JS, monorepo earns its keep.** Shared TypeScript types are the killer feature — contract changes propagate as compile errors across `apps/api`, `apps/admin`, `apps/partners` instantly. Atomic PRs spanning all three are routine. One Node version, one lint config, one CI pipeline.
- **Flutter goes separate.** Different toolchain (Dart + pubspec), different deploy cadence, different mental model. Mobile app will live in the same Flutter repo when it lands.
- **The cross-language contract is solvable.** The Fastify backend's OpenAPI spec is the bridge — generated automatically, consumed by Flutter via codegen.

## Core Platform — what's in it

Five layers. Each portal calls only the top layer (API), which delegates inward.

### Layer 1 — Data

A single relational database holds the source of truth for every entity. The conceptual entity list:

| Domain | Entity | Purpose |
|---|---|---|
| Identity | `User` | One row per human. The same User signs in on circls.app and partners.circls.app — never duplicated. |
| Identity | `TenantMember` | Many-to-many: which Users may act on behalf of which Tenant in which role (owner / staff / read-only). |
| Tenancy | `Tenant` | The venue-owning business entity. Holds Razorpay Linked Account ID, KYC state, subscription state. |
| Inventory | `Venue` | Physical location. Belongs to a Tenant. Carries address + geopoint + photos. |
| Inventory | `Arena` | Bookable resource within a Venue (court, pool, hall, etc.). Has sport, capacity, slot duration. |
| Inventory | `Schedule` | The Arena's regular weekly availability + date-specific overrides (holidays, blocked windows). |
| Inventory | `PricingRule` | Variable pricing applied to slots — per arena, per time-of-day, per day-of-week, per channel, per member-status. |
| Catalog | `Event` | Venue-level activity (tournament, open game, league). May reserve one or more Arenas during its window. |
| Catalog | `Membership` | Venue-level pass (e.g., 10-game punch card, monthly unlimited). |
| Catalog | `UserMembership` | A consumer's active membership purchase against a specific Membership. |
| Booking | `Booking` | Unified ledger row for any bookable item (slot / event / membership). Carries channel, paymentMethod, state, customer ref. |
| Money | `Payment` | A money movement. **0..N per Booking.** Refunds are Payment rows with opposite-sign amount. |
| Money | `PayoutRecord` | Unified payout view joining Razorpay settlement records (A, C1) + aggregator-reported settlements (B) + manually entered (C2, D). |
| Integration | `ApiKey` | Machine-auth credential for Integration Surface consumers. Scoped per tenant or platform-wide. |
| Integration | `WebhookSubscription` | Outbound webhook endpoint + signing secret + delivery state. |
| Operations | `AuditLog` | Append-only record of all financial, KYC, admin, and tenant-membership actions. |

### Locked data-model decisions

These are agreed and will not move without explicit revisit:

1. **Bookings and Payments are separate tables.** A Booking has 0..N Payment rows. A refund is a Payment row with opposite-sign amount. The Booking's "paid status" is **derived** from its Payment rows, not stored on the Booking itself.
2. **One User, many contexts.** A consumer on circls.app and a venue-staff member on partners.circls.app are the same `User` entity with different role contexts (via `TenantMember`) — never duplicate accounts.
3. **Channel is first-class on every Booking.** Every booking row carries which channel it originated from (circls / aggregator-X / venue-site / walk-in). This is what makes channel-specific commission rules possible.
4. **`paymentMethod = free` is a first-class value.** Free events and memberships skip KYC gating and create zero Payment rows. A Booking's `paymentMethod` is one of: `razorpay-route`, `external`, `free`.
5. **Visibility is binary — no draft state.** When a venue creates an Arena, Event, or Membership in the Partner Portal, it becomes immediately visible on circls.app. There is no draft → preview → publish workflow.
6. **Inventory has exactly one source of truth.** Every bookable interval on an Arena lives in Core's database. No channel may write availability "out of band." See *Inventory ownership invariant* below.

### Schema decisions (column-level shape)

These determine the storage shape of every table. Locked 2026-05-19.

| # | Decision | Choice |
|---|---|---|
| 1 | **Primary keys** | **UUID v7** via the `pg_uuidv7` extension on Neon. Time-ordered so B-tree indexes stay clean; no business-volume leakage; client-generatable for optimistic UI. |
| 2 | **Money** | **`BIGINT` paise** for every money column. Currency is INR-only at MVP; multi-currency deferred. No floats anywhere in the data path. |
| 3 | **Time + timezone** | **`TIMESTAMPTZ`** for every datetime column. `Venue` carries an IANA `tz_name` (e.g., `Asia/Kolkata`) for rendering in venue-local time on the frontend. Never use `TIMESTAMP WITHOUT TZ`. |
| 4 | **Delete strategy** | **Status enum + selective hard-delete + append-only financials.** Concrete map: <br>• **Status enum** on Booking, Tenant, Venue, Arena, Event, Membership, UserMembership, ApiKey, WebhookSubscription, TenantMember. <br>• **Hard-delete on TTL** for ephemeral rows: idempotency keys, expired sessions, abandoned-cart bookings (after sweep grace period). <br>• **Append-only, never deleted:** Payment, PayoutRecord, AuditLog. |
| 5 | **Tenancy enforcement** | **App-layer filtering** via a typed `withTenant(ctx, db)` query-wrapper using Drizzle. Mistakes = compile errors, not data leaks. Admin scope bypasses via an explicit `withAdmin(db)` — rare and auditable. RLS not used; tooling cost not worth it at our scope. |
| 6 | **Schedule modeling** | **Open time-range with a `tstzrange` GIST exclusion constraint.** Arena has `weekly_schedule` rows: `(day_of_week, start_time, end_time, slot_duration_min)`. Bookings stored as time ranges. The DB itself rejects overlapping bookings via `EXCLUDE USING GIST (arena_id WITH =, time_range WITH &&)` — no race condition, no app-layer lock dance. |
| 7 | **User role contexts** | **Single `role` enum on `TenantMember`** (`owner` / `manager` / `staff` / `readonly`) + nullable `permissions_override jsonb` column reserved for future custom-cases (not populated on day one). |
| 8 | **Pricing rules** | **Explicit-column rule rows with priority ordering.** Each rule = one row: `(arena_id, priority, day_of_week, start_time_min, start_time_max, channel, member_only, price_paise)`. Engine picks the highest-priority matching rule. Queryable, renderable in UI, validatable. |
| 9 | **Booking polymorphism** | **Single `bookings` table with `item_type` enum + nullable per-type FKs + `CHECK` constraint.** Columns include `(item_type, slot_arena_id, slot_time_range, event_id, membership_id, …)`. CHECK ensures exactly one set populated per row. Preserves the unified-ledger property. |

### Layer 2 — Domain services (pure business logic)

Pure logic, no I/O. The same service is called whether a booking originates from circls.app, an aggregator, or a walk-in dashboard click.

| Service | Responsibility |
|---|---|
| Inventory engine | Slot resolution, conflict detection, transactional booking. Single decision-maker for "is this arena free at this moment?" |
| Pricing engine | Applies `PricingRule` rows to resolve the actual price for (arena, date, time, channel, member-status). |
| Cancellation engine | Applies cancellation policy to decide refund eligibility + amount. |
| Payment-routing logic | Builds the Razorpay Route transfer array for a Booking; selects between `razorpay-route` / `external` / `free` paths based on channel + paymentMethod. |
| Settlement-hold logic | Computes settlement hold duration for a Booking from its cancellation policy + slot start + buffer. |
| Refund engine | Channel-aware refund decision tree. Issues Razorpay refunds for A/C1; records state only for B/C2/D. |
| Identity & authorization | Verifies JWT, resolves User → Tenant context, enforces role rules. |

### Layer 3 — External integrations (adapters)

Each external dependency is isolated behind a thin adapter so it can be mocked in tests and swapped if needed.

| Integration | Purpose |
|---|---|
| Razorpay | Orders, Route transfers, refunds, Linked Account KYC, Subscriptions for tenant SaaS billing |
| Aggregator inbound (Playo, Khelomore, …) | Webhooks: booking confirmed, cancelled, refunded |
| SMS gateway | OTP, booking confirmations, reminders |
| Email gateway | Receipts, KYC status, payout statements |
| WhatsApp gateway | Booking confirmations, reminders (richer than SMS) |
| Object storage | Venue photos, event banners, profile pictures |
| Search index (when needed) | circls.app discovery (sport + location + time). Optional for v0 — DB query is fine. |

### Layer 4 — Asynchronous workers

A job queue runs background tasks. None of these sit in the request path of a portal call.

- **Settlement-release ticker** — periodically marks held settlements as released past their expiry.
- **Payout reconciliation** — joins Razorpay settlement records to Booking + Payment rows.
- **Reminder dispatch** — pre-slot SMS / WhatsApp reminders to consumers.
- **KYC status poll** — periodically polls Razorpay for tenant KYC progress; updates Tenant state on change.
- **Webhook delivery** — outbound webhook dispatch with signed payload + retry-with-backoff.
- **Abandoned-cart sweep** — cancels unconfirmed bookings past timeout, freeing the slot.
- **Subscription billing** — charges tenant SaaS subscriptions on schedule (when revenue model lands).

### Layer 5 — API (the only thing portals call)

A typed HTTP API is the only way to interact with the Core. Four audiences, **one API surface**:

| Audience | Auth | Scope |
|---|---|---|
| **Consumer** | JWT (phone OTP via Firebase Auth or equivalent) | Read public venues / events / memberships; create + manage own bookings; view own profile |
| **Partner** (venue staff) | JWT, resolved via `TenantMember` | Manage own tenant's venues / arenas / schedules / pricing / events / memberships / bookings / payouts |
| **Admin** (Circls internal) | JWT + admin role check | All tenant data; KYC overrides; refund issuance; audit log; config |
| **Integration** (aggregator / venue dev) | API key (per integrator), scoped per tenant or platform-wide | Channel-scoped read + write on permitted inventory + bookings |

**Same endpoints, different scopes.** An aggregator creating a booking is the same code path as circls.app creating a booking. The request differs only in (a) auth method and (b) the resolved `channel` value attached to the resulting Booking row.

## Inventory ownership — the central invariant

> Every bookable interval (slot) on an Arena has exactly one source of truth: Core's database.

Every channel that creates a booking must go through Core. Core decides whether the slot is available, locks it transactionally, and records the Booking row with its channel. No channel may write availability out of band.

This is what makes channel coexistence work. Playo and circls.app racing for the same slot at the same instant must be resolvable inside Core's transactional layer — "last-writer-wins" is wrong; the correct outcome is "one Booking is created, the other call returns `slot_taken`."

Hard implications of this invariant:
- The database must support real transactions (relational, ACID).
- The API must use idempotency keys on `createBooking` so retries don't double-book.
- The Inventory engine is the **only** place that decides availability — neither the Partner Portal nor circls.app may "pre-check" availability and assume the answer holds.

## How each portal uses Core

| Portal | Auth | What it reads / writes |
|---|---|---|
| **Partner Portal** | Partner JWT, tenant-scoped | Onboarding, KYC submission, venues, arenas, schedules, pricing rules, events, memberships, bookings (R+W), payouts (R), subscription |
| **Consumer App** (circls.app) | Consumer JWT (or anonymous for browse) | Venue discovery, arena availability, booking creation, payment, own booking history, memberships purchase |
| **Admin Console** | Admin JWT | All tenant data; KYC overrides; refund issuance; audit log; config |
| **Integration Surface** | API key | Channel-scoped: read availability, create + cancel bookings, receive outbound webhooks |
| **Mobile** (P1) | Same as Consumer App | Same as Consumer App |

## Money flow architecture

Recap of channel × money-flow (full detail in [`VISION.md`](VISION.md)):

| Channel | Payment instrument | Money touches Circls? | Refund mechanism |
|---|---|---|---|
| A — circls.app | Razorpay Route | No — instant split | Settlement hold |
| B — aggregator | Aggregator's PSP | No — aggregator settles to venue | Aggregator-handled |
| C1 — venue site (Circls PSP) | Razorpay Route | No — instant split | Settlement hold |
| C2 — venue site (own PSP) | Venue's own PSP | No — recorded only | Venue-handled |
| D — walk-in | Cash / venue UPI / POS | No — recorded only | Venue-handled |

**Implication for Core:** Core records every Booking, but only **issues payment instructions** for Channels A and C1 (via the Razorpay Route adapter). For B / C2 / D, Core records what happened — no money movement is initiated by Circls.

## Open architectural questions

These remain open; each is a downstream choice from the locked stack.

**Sub-decisions waiting on first implementation:**
- **Worker process shape** — single codebase, two entry points (`pnpm api:server` / `pnpm api:worker`) — direction agreed; wiring done at build time.
- **OpenAPI codegen for Flutter** — which Dart generator (`openapi-generator-cli` with `dart-dio`, or alternatives) — decided when first endpoint exists.
- **Local dev** — docker-compose for Postgres locally vs a Neon branch per developer — cheap to defer.
- **Secrets management** — Fly.io secrets + Vercel env vars + shared store (Doppler / 1Password) for cross-environment configs.
- **Staging environment** — Neon branching makes per-PR DB environments cheap; worth setting up alongside CI.

**Data-modeling follow-ups (next round):**
- `Payment` table shape (status fields, Razorpay refs, charge vs refund vs adjustment).
- `AuditLog` payload JSONB schema.
- Geolocation (`lat`/`lng` columns vs PostGIS — lean simple for v0).
- Idempotency-key table shape.
- `Subscription` / `SubscriptionPlan` shape (when revenue model lands).
- Channel / commission configuration (likely a `tenant_channel` table).
- Specific enum values for each enum column.
- Index strategy.

**Capability decisions (deferred until needed):**
- **Search backend** — none for v0 (DB query is fine); Postgres FTS or external (Meilisearch / Typesense) when needed.
- **Notification gateway choice** — which SMS / WhatsApp / email providers.
- **Mobile app implementation** — Flutter codebase will be reused; concrete decision deferred until consumer app is stable.

## What this document does not cover

- Specific endpoint contracts → will live in an OpenAPI spec emitted by the Fastify backend.
- DB migrations themselves (the actual `CREATE TABLE` SQL with all columns) → live in `apps/api/src/db/migrations/`.
- Hosting / DevOps layout → captured in `apps/api/fly.toml`, Vercel project configs, Cloudflare Pages build settings.
- UX flows → per-product feature docs.
- Revenue model (commission % per channel, subscription tier pricing) → open product decision.
