# Circls Platform — Implementation Guide

> Phased build plan. **One phase per session.** Each phase has a single, reviewable goal. Phases are sequenced by dependency — don't skip ahead. Locked decisions live in [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md); the *what* and *why* live in [`docs/VISION.md`](./docs/VISION.md). This document is the *how* and *when*.

## Working pattern

Every session follows this rhythm:

1. **Open the guide** — confirm which phase we're on.
2. **Agree the goal + deliverables** in 2 minutes before any code is written.
3. **Build** the phase's deliverables.
4. **Verify locally** per the phase's Verify section.
5. **Update this guide** with the *Actual outcome* line at the bottom of the phase (note any deviations or follow-ups created).
6. **Commit + push** with the phase tag in the commit message (e.g., `phase-1: backend skeleton`).
7. **Stop.** Don't pre-emptively start the next phase. Vedant reviews, then we open the next session.

Branching: each phase is built on `main` directly for now (small team, no PR ceremony needed). If/when team grows, switch to PR-per-phase against `main`.

Commit message style: `phase-N: <slug> — <short description>`. Example: `phase-2: drizzle-neon — first migration, users table only`.

## Conventions (locked)

- **Node 24** (via `.nvmrc`). `nvm use` before any command.
- **pnpm 9** for all installs. Never npm or yarn.
- **TypeScript strict mode** on every package (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).
- **DB columns:** `snake_case`. TypeScript / API: `camelCase`. Drizzle's `mapped` field name handles the bridge.
- **Money:** always `BIGINT` paise, suffix the variable with `Paise` (e.g., `pricePaise`). Never store rupees as decimals.
- **Datetime:** always `TIMESTAMPTZ`. Always UTC at rest. Render in venue-local TZ on the frontend using the Venue's `tz_name`.
- **IDs:** UUID v7 via `pg_uuidv7` extension. Generated server-side at insert.
- **Auth header:** `Authorization: Bearer <firebase-jwt>` for consumer/partner/admin; `X-API-Key: <key>` for integration partners.
- **Error shape:** all errors return `{error: {code: string, message: string, details?: object}}`. Codes are stable strings like `slot_taken`, `kyc_pending`, `auth_required`.
- **API versioning:** every route prefixed `/v1/`. Bump to `/v2/` only if a breaking change is unavoidable.
- **Idempotency:** `POST` endpoints that create rows require an `Idempotency-Key` header. Server stores responses for 24h.

## Prerequisites (Vedant ops — do these before the relevant phase, not all at once)

| When needed | What |
|---|---|
| Phase 1 | Node 24 + pnpm 9 installed locally. Docker Desktop installed (for local Postgres if not using Neon directly in dev). |
| Phase 1 | Fly.io account + `fly` CLI installed + `fly auth login`. |
| Phase 2 | Neon account created. New Neon project named `circls-platform`. Get the connection string. |
| Phase 3 | Firebase project (new or reuse stage). Enable phone OTP + email/password sign-in methods. Download a service-account JSON for the backend. |
| Phase 5 | Vercel account + Vercel CLI + `vercel login`. New Vercel project for `apps/admin`. |
| Phase 6 | Same as Phase 5, second Vercel project for `apps/partners`. |
| Phase 11 | Razorpay test-mode account. Note the Key ID + Key Secret. Apply for live-mode (24-72h approval). |
| Phase 11 | Cloudflare account + create an R2 bucket named `circls-assets`. |
| Phase 13 | Pick + sign up for SMS / WhatsApp / email providers (decision deferred until phase). |

## Phases

### Phase 0 — Repo foundation ✅

**Goal:** `circls-platform` repo exists on GitHub and locally; docs copied over; `IMPLEMENTATION_GUIDE.md` written.

**Done in this session.** No code yet.

---

### Phase 1 — Backend skeleton (`apps/api`)

**Goal:** Fastify TypeScript service boots locally with `pnpm dev`, responds 200 on `GET /v1/health`, validated env config, Pino logging, graceful shutdown, Dockerfile + `fly.toml` ready (not deployed yet).

**Deliverables:**
- `apps/api/package.json` — fastify@^5, @fastify/cors, @fastify/helmet, @fastify/sensible, pino, pino-pretty, zod; devDeps tsx, typescript, vitest, @types/node.
- `apps/api/tsconfig.json` — strict mode, NodeNext, ES2024.
- `apps/api/src/index.ts` — entrypoint with SIGTERM/SIGINT graceful shutdown.
- `apps/api/src/server.ts` — `buildServer()` factory; CORS + helmet + sensible plugins; error→HTTP mapping; 404 handler.
- `apps/api/src/config/env.ts` — zod-validated env, exits on validation failure.
- `apps/api/src/lib/logger.ts` — Pino + pino-pretty in dev.
- `apps/api/src/lib/errors.ts` — `AppError` hierarchy: `BadRequest`, `Unauthorized`, `Forbidden`, `NotFound`, `Conflict`, `RateLimit`, `Upstream`.
- `apps/api/src/routes/health.ts` — `/v1/health` + `/v1/health/live`.
- `apps/api/.env.example` — `PORT=8080`, `LOG_LEVEL=info`.
- `apps/api/Dockerfile` — multi-stage Node 24-alpine, pnpm install via corepack.
- `apps/api/fly.toml` — `primary_region = "bom"`, single `app` process on `:8080`.
- Root `package.json` — wire `pnpm dev` to filter `@circls/api`.

**Verify:**
- `pnpm install` succeeds at repo root.
- `pnpm --filter @circls/api dev` boots; logs to terminal.
- `curl -s http://localhost:8080/v1/health` returns `{"ok":true}`.
- `pnpm --filter @circls/api typecheck` clean.
- `pnpm --filter @circls/api build` produces `dist/`.

**Decisions made in this phase:**
- Fastify plugin set (the ones above are recommended; flag any).
- Exact env-var names.
- Health endpoint payload shape.
- Local dev port (8080 recommended).

**Out of scope (will exist later):** DB connection, auth, any real route. The health check is intentionally the only endpoint.

**Actual outcome:**
- Fastify v5 server in `apps/api` boots on `:8080`. `GET /v1/health` and `/v1/health/live` both return `{ok:true}`. Unknown routes return `{error:{code:"not_found",message:"..."}}`.
- Plugins registered: `@fastify/cors` (origin: true, credentials: true), `@fastify/helmet` (defaults), `@fastify/sensible`. Rate-limit + swagger deferred until they have a real consumer.
- Env: `PORT`, `LOG_LEVEL`, `NODE_ENV` — zod-validated in `src/config/env.ts`; invalid env fails fast with a readable error.
- Logger: Fastify-owned Pino instance using pino-pretty in non-prod; a standalone `lib/logger.ts` covers entrypoint lifecycle logs (boot, shutdown).
- Errors: `AppError` hierarchy (`BadRequest`/`Unauthorized`/`Forbidden`/`NotFound`/`Conflict`/`RateLimit`/`Upstream`) → mapped to the shared `{error:{code,message,details?}}` shape by `setErrorHandler`. Fastify validation errors → 400 `bad_request`. Unhandled → 500 `internal_error` (message hidden in production).
- Graceful shutdown: SIGTERM/SIGINT call `app.close()`; verified by sending SIGTERM in dev (`shutdown_start` log emitted before exit; final flushed line is occasionally lost to pino-pretty's worker transport — non-blocking for Phase 1).
- Dockerfile is multi-stage; build context is the repo root (`docker build -f apps/api/Dockerfile .`). Uses `pnpm deploy --prod /out` for a clean runtime artifact. Runs as the `node` user, exposes 8080.
- `fly.toml` placed but not deployed — primary_region `bom`, single `app` process running `node dist/index.js`, health check on `/v1/health/live`.
- Root `pnpm dev` now filters to `@circls/api`.

**Deviations from the guide:**
- **Node 24, not 22**: `.nvmrc`, root + api `engines.node`, Dockerfile base image, and the guide's own Conventions/Prerequisites entries were bumped to Node 24 (current LTS). Phase-1 decision.
- Added `apps/api/.dockerignore` (not in the deliverable list) — necessary to keep `node_modules` out of the Docker build context.

**Follow-ups queued:**
- `pnpm` itself flags an upgrade `9.12.0 → 11.x` available. Phase-1 stays on 9.12.0 (locked in `packageManager`). Bump as a separate, deliberate step before any phase that depends on it.

---

### Phase 2 — Database + Drizzle

**Goal:** Neon database wired; `pg_uuidv7` extension installed; Drizzle ORM connected; first migration creates the `users` table; the API can `SELECT 1` on startup as a connection check.

**Vedant ops before this phase:** Neon project created, connection string in hand.

**Deliverables:**
- `apps/api/package.json` — add drizzle-orm, postgres@^3, drizzle-kit (dev).
- `apps/api/drizzle.config.ts` — postgresql dialect, schema at `src/db/schema/index.ts`, migrations to `src/db/migrations/`.
- `apps/api/src/db/client.ts` — `postgres-js` client + drizzle wrapper. **`prepare: false`** for Neon pgbouncer compatibility.
- `apps/api/src/db/schema/index.ts` — barrel export.
- `apps/api/src/db/schema/_columns.ts` — shared column helpers (`uuidPk()`, `createdAt()`, `updatedAt()`, `bigintPaise()`).
- `apps/api/src/db/schema/users.ts` — `users` table: `id (uuid v7)`, `firebase_uid (text, unique)`, `phone_e164 (text, nullable, unique)`, `email (text, nullable, unique)`, `display_name (text, nullable)`, `status (enum: active/suspended)`, `created_at`, `updated_at`.
- `apps/api/src/db/migrations/0001_enable_uuidv7.sql` — `CREATE EXTENSION IF NOT EXISTS pg_uuidv7;`
- `apps/api/src/db/migrations/0002_users.sql` — `users` table.
- `apps/api/src/db/migrate.ts` — runs migrations programmatically; called as `pnpm db:migrate`.
- `.env.example` — add `DATABASE_URL=postgres://...`.
- API startup: a `pingDb()` call that logs "DB connected" or exits on failure.

**Verify:**
- `pnpm db:migrate` runs cleanly against Neon.
- `SELECT * FROM users;` on Neon dashboard returns 0 rows.
- `SELECT id FROM users LIMIT 1;` after a manual insert returns a UUID v7 starting with `01…` (current timestamp prefix).
- API server logs "DB connected" on boot.

**Decisions made:**
- Migration filename convention (`NNNN_slug.sql` recommended).
- Drizzle's `mapped` snake_case ↔ camelCase pattern.
- Connection-pool size for Neon (start low, e.g., 10).

**Actual outcome:** _(fill in after the session)_

---

### Phase 3 — Auth integration

**Goal:** Firebase Admin SDK wired; JWT verification middleware works; `GET /v1/me` returns the authenticated user (find-or-create on first call).

**Vedant ops before this phase:** Firebase project created, phone OTP enabled, service-account JSON downloaded. Add the JSON contents (base64 or raw) to `apps/api/.env.local` as `FIREBASE_SERVICE_ACCOUNT`.

**Deliverables:**
- Add `firebase-admin` to `apps/api/package.json`.
- `apps/api/src/lib/firebase_admin.ts` — singleton `firebaseAuth()`; loads service account from env.
- `apps/api/src/middleware/require_auth.ts` — Fastify hook that verifies JWT, attaches `req.user = { firebaseUid, claims }`.
- `apps/api/src/services/user_service.ts` — `findOrCreateByFirebaseUid(uid, phoneOrEmail)`.
- `apps/api/src/routes/me.ts` — `GET /v1/me`; auth-required; returns `User` row, creating on first call.
- `packages/api-types/` — new workspace package (sets up `packages/api-types/package.json`, `tsconfig.json`, `src/index.ts`, `src/user.ts`). `apps/api` imports from `@circls/api-types`.

**Verify:**
- `curl localhost:8080/v1/me` without JWT → 401 with `{error: {code: "auth_required"}}`.
- With a valid Firebase phone-OTP JWT → 200 with the User row.
- Second call → same `id` (idempotent find-or-create).
- Manual SQL confirms the User row was inserted.

**Decisions made:**
- Auto-provisioning behavior (default: create on first authenticated call). Alternative: explicit signup endpoint.
- Whether to mirror Firebase claims into the User row vs always fetching live.
- `@circls/api-types` build strategy (recommend: source-only exports via `exports` field; no pre-compile step in dev).

**Actual outcome:** _(fill in)_

---

### Phase 4 — Admin Console skeleton (`apps/admin`)

**Goal:** Next.js 15 admin shell. Email/password login via Firebase Auth. Protected layout calls `/v1/me` and renders the admin's email + Firebase UID. Vercel preview deploy works.

**Vedant ops before this phase:** Vercel project created for `apps/admin`. Add `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_PROJECT_ID`, `NEXT_PUBLIC_API_BASE_URL` to Vercel + local `.env.local`.

**Deliverables:**
- `apps/admin/package.json` — next@^15, react@^19, @tanstack/react-query@^5, firebase@^11, tailwindcss@^4, @circls/api-types.
- `apps/admin/next.config.ts` — typedRoutes, transpilePackages `['@circls/api-types']`, output `standalone`.
- `apps/admin/tsconfig.json`, `apps/admin/postcss.config.mjs`, `apps/admin/eslint.config.mjs`.
- `apps/admin/app/layout.tsx` — root html/body + providers + `robots: { index: false }`.
- `apps/admin/app/globals.css` — Tailwind v4 `@import "tailwindcss"` + brand palette via `@theme`.
- `apps/admin/app/providers.tsx` — TanStack Query client + AuthProvider.
- `apps/admin/app/(auth)/login/page.tsx` — email/password form.
- `apps/admin/app/(protected)/layout.tsx` — client-side gate (W phase-12 moves to middleware).
- `apps/admin/app/(protected)/dashboard/page.tsx` — placeholder showing `useMe()` result.
- `apps/admin/lib/firebase/client.ts` — Firebase init.
- `apps/admin/lib/firebase/auth_context.tsx` — `AuthProvider` + `useAuth()`.
- `apps/admin/lib/api/client.ts` — fetch wrapper attaching `Authorization: Bearer <jwt>`.
- `apps/admin/lib/api/queries.ts` — `useMe()` Hook calling `/v1/me`.
- `apps/admin/vercel.json` — monorepo build command.
- `apps/admin/.env.local.example`.

**Verify:**
- `pnpm --filter @circls/admin dev` boots on `:3000`.
- Sign in with email/password → land on `/dashboard` → see the User row from `/v1/me`.
- Sign out → redirected to `/login`.
- Vercel preview deploys cleanly.

**Decisions made:**
- TanStack Query defaults (stale time, retry policy).
- Brand colors (Tailwind `@theme` palette).
- Whether server-side auth gate (middleware) is in scope here or deferred to a later phase.

**Actual outcome:** _(fill in)_

---

### Phase 5 — Partner Portal skeleton (`apps/partners`)

**Goal:** Mirror of Phase 4 but with phone-OTP login (Firebase phone auth). Renders `useMe()` result on the protected dashboard. Vercel preview deploy works.

**Deliverables:** Identical shape to `apps/admin` but with:
- `apps/partners/app/(auth)/login/page.tsx` — phone-input + OTP-confirmation flow.
- Firebase recaptcha container in `app/layout.tsx`.

**Verify:** Sign in with phone OTP → see User row → sign out works.

**Decisions made:**
- Phone country-code handling (E.164, India `+91` default).
- Recaptcha mode (invisible — same as legacy circls.app).
- Whether onboarding flow lives here (no — Phase 7 adds it).

**Actual outcome:** _(fill in)_

---

### Phase 6 — Tenant entity + creation flow

**Goal:** A signed-in partner can create a Tenant. Admin can list all tenants. `TenantMember` table exists; creator is automatically `owner`.

**Deliverables:**
- `apps/api/src/db/schema/tenants.ts` — `tenants` table per ARCHITECTURE.md: `id`, `name`, `slug (unique)`, `legal_entity_name`, `gstin (nullable)`, `address_jsonb (nullable until Phase 7)`, `kyc_status (enum: not_started/in_review/verified/rejected, default 'not_started')`, `razorpay_linked_account_id (nullable)`, `subscription_status (enum: trial/active/suspended/cancelled, default 'trial')`, `status (enum: active/suspended)`, timestamps.
- `apps/api/src/db/schema/tenant_members.ts` — `(user_id, tenant_id, role enum(owner/manager/staff/readonly), permissions_override jsonb null, created_at)`; composite PK `(user_id, tenant_id)`.
- Migrations `0003_tenants.sql`, `0004_tenant_members.sql`.
- `apps/api/src/middleware/with_tenant.ts` — the typed query-wrapper. `withTenant(req, db)` returns a proxy that auto-injects `WHERE tenant_id = ?` on every Drizzle query.
- `apps/api/src/services/tenant_service.ts` — `createTenant`, `listTenantsForUser`, `listAllTenants`.
- `apps/api/src/routes/tenants.ts` — `POST /v1/tenants`, `GET /v1/tenants` (admin), `GET /v1/me/tenants` (partner).
- `packages/api-types/src/tenant.ts` — `Tenant` + `CreateTenantRequest`.
- `apps/partners/app/(protected)/onboarding/create-tenant/page.tsx` — form.
- `apps/admin/app/(protected)/tenants/page.tsx` — table view.

**Verify:**
- Partner: create tenant → row inserted; TenantMember row created with `role='owner'`.
- Admin: see all tenants in list.
- Slug uniqueness enforced (try duplicate → 409 `slug_taken`).
- `withTenant` wrapper: a partner querying `tenants` only sees their own.

**Decisions made:**
- Tenant slug generation rules (lowercase, dashes, no spaces — recommend auto-generate from name with user override).
- What's required at tenant-creation time vs deferred to onboarding wizard (recommend: just name + slug; rest in Phase 7).

**Actual outcome:** _(fill in)_

---

### Phase 7 — Venue entity + onboarding wizard

**Goal:** Partner can create Venues under their Tenant. Venue has address, geopoint (lat/lng pair, no PostGIS), photos (upload to R2 deferred to Phase 11). Onboarding wizard flow in Partner Portal walks tenant → first venue.

**Deliverables:**
- `apps/api/src/db/schema/venues.ts`. Migration `0005_venues.sql`.
- Routes: `POST /v1/tenants/:tenantId/venues`, `GET /v1/venues/:id`, `PATCH`, soft-delete via status enum.
- Partner UI: multi-step wizard.

**Verify:** Partner creates tenant → guided to add a venue → venue row exists; lat/lng captured.

**Actual outcome:** _(fill in)_

---

### Phase 8 — Arenas + Schedules + the GIST exclusion constraint

**Goal:** Arenas exist under Venues. Each Arena has a weekly schedule. The `bookings` table is created with `tstzrange` column and `EXCLUDE USING GIST (arena_id WITH =, time_range WITH &&) WHERE (status NOT IN ('cancelled'))` — but **no Booking writes happen yet** (Phase 9 does that). This phase only stands up the inventory primitives.

**Deliverables:**
- `arenas` table, `weekly_schedule` table, empty `bookings` table with the exclusion constraint.
- Partner UI: arena create form + weekly-schedule grid editor.
- Migration `0006_arenas_schedules_bookings.sql` — includes `CREATE EXTENSION IF NOT EXISTS btree_gist;` (required for the exclusion constraint).

**Verify:** Arena created. Weekly schedule rendered correctly in UI. Manual insert of two overlapping bookings rejected by DB.

**Actual outcome:** _(fill in)_

---

### Phase 9 — Walk-in bookings (Channel D, no payment)

**Goal:** Partner can create a walk-in booking from the Partner Portal. Booking row created with `paymentMethod='external'`, `channel='walkin'`. The inventory invariant is exercised: try to double-book → DB rejects → API returns `slot_taken`.

**Deliverables:**
- `bookings` columns finalized (item_type, slot_arena_id, time_range, channel, paymentMethod, status, item_data jsonb, customer_user_id/customer_contact_jsonb, created_by_user_id, created_at).
- `POST /v1/bookings` — idempotency key required.
- Inventory engine in `apps/api/src/services/inventory_service.ts` — uses Drizzle transactions; catches the GIST exclusion violation and returns `slot_taken`.
- Partner UI: a calendar / time-grid showing the Arena's day, with click-to-book.

**Verify:** Two concurrent booking attempts on the same slot → exactly one succeeds. Cancellation flips status to `cancelled`; the slot becomes bookable again (because the GIST exclusion excludes cancelled bookings).

**Decisions made:** Idempotency key shape. How long an unconfirmed booking holds the slot (suggest 5 minutes via `pending` status + a sweep job — sweep job lands in Phase 12).

**Actual outcome:** _(fill in)_

---

### Phase 10 — PricingRule + price resolution

**Goal:** Pricing engine works. Partner creates pricing rules; bookings resolve to the correct price; the price is stored on the Booking row at creation time (not re-resolved later).

**Deliverables:**
- `pricing_rules` table per ARCHITECTURE.md (#8 schema decision).
- `apps/api/src/services/pricing_service.ts` — `resolvePricePaise({arenaId, startAt, endAt, channel, memberOnly})`.
- Partner UI: pricing rule list + add/edit form.

**Verify:** Add a "Saturday evening surcharge"; verify booking on Sat 6pm gets the surcharge; Wed at noon gets the default.

**Actual outcome:** _(fill in)_

---

### Phase 11 — Razorpay Linked Account + KYC onboarding

**Goal:** A Tenant can submit KYC details (PAN, GST, bank). Razorpay Linked Account is created via API. KYC status reflected on Tenant. Background poller updates status as Razorpay verifies.

**Vedant ops before this phase:** Razorpay test-mode account + Key. Webhook endpoint URL to register with Razorpay (use a Cloudflare tunnel or ngrok for dev). Cloudflare R2 bucket for KYC document uploads.

**Deliverables:**
- Cloudflare R2 adapter in `apps/api/src/lib/storage.ts` (S3 SDK with R2 endpoint). Pre-signed URL endpoint for the Partner Portal to upload directly.
- Razorpay adapter in `apps/api/src/lib/razorpay.ts`.
- `POST /v1/tenants/:id/kyc` — accepts the KYC bundle, creates Linked Account, stores `razorpay_linked_account_id`.
- pg-boss installed; `apps/api/src/worker/index.ts` entry point added.
- `kyc_status_poll` job — runs every 30 min, polls all tenants with `kyc_status='in_review'`.
- `fly.toml` updated for a second `worker` process.
- Partner UI: KYC form with file uploads + status display.

**Verify:** Submit KYC → Linked Account created in Razorpay dashboard. Poller updates `kyc_status` to `verified` after Razorpay approves.

**Decisions made:** Razorpay webhook signature verification setup. R2 bucket naming. Whether KYC docs are deleted post-verification or retained.

**Actual outcome:** _(fill in)_

---

### Phase 12 — Online booking via Razorpay Route (Channel A)

**Goal:** A consumer (impersonated from admin for now) can book a slot online. Razorpay Route order created with split. Payment confirms → Booking moves to `confirmed`. Settlement-hold logic kicks in.

**Deliverables:**
- `payments` table — `id`, `booking_id`, `provider`, `provider_payment_id`, `amount_paise (signed: positive=charge, negative=refund)`, `currency`, `status`, `kind (charge/refund/adjustment)`, `metadata jsonb`, timestamps.
- `payouts` table (PayoutRecord — empty for now, populated by reconciliation worker in Phase 14).
- Settlement-hold logic in `apps/api/src/services/settlement_hold_service.ts`.
- `POST /v1/bookings` enhanced — for `paymentMethod='razorpay-route'`, returns `payment.order_id` for the client to use.
- Razorpay webhook handler at `POST /webhooks/razorpay` (signature-verified).
- `settlement_release_ticker` job.
- `abandoned_cart_sweep` job — cancels `pending` bookings after grace period.

**Verify:** Create a booking via API with test-mode payment → Razorpay Route order has the correct split → payment success webhook → Booking confirms → Payment row created.

**Decisions made:** Settlement hold buffer (suggest cancellation_window + 1 hour). Webhook idempotency strategy.

**Actual outcome:** _(fill in)_

---

### Phase 13 — Notifications (SMS, email, optional WhatsApp)

**Goal:** Booking confirmations, OTPs, reminders dispatched via SMS + email. WhatsApp added if a provider is signed up.

**Vedant ops before this phase:** Pick providers (recommendations: MSG91 for SMS in India, Resend for transactional email, AiSensy or Gupshup for WhatsApp). Sign up.

**Deliverables:**
- Notification dispatcher in `apps/api/src/lib/notifications/`.
- Template-rendering service.
- Background jobs for reminders (T-24h, T-1h SMS/WhatsApp pre-slot).
- Audit log written for every notification dispatch.

**Verify:** Book a slot → SMS arrives. Cancel a slot → SMS arrives. KYC verified → email arrives.

**Actual outcome:** _(fill in)_

---

### Phase 14 — Cancellations + refunds

**Goal:** Cancellation engine works. Refund engine works. For Channel A/C1, Razorpay refund is issued; settlement-hold logic prevents the venue from receiving money on cancelled bookings.

**Deliverables:**
- `apps/api/src/services/cancellation_service.ts`.
- `apps/api/src/services/refund_service.ts` — branches by channel.
- `payout_reconciliation` worker — daily, joins Razorpay settlements to Payment rows.
- Partner UI: cancellation reason, refund visibility.
- Admin UI: manual refund button (out-of-policy).

**Verify:** Cancel within window → refund issued → Razorpay shows refund → Booking status updated.

**Actual outcome:** _(fill in)_

---

### Phase 15 — Events + Memberships (catalog)

**Goal:** Tenant can publish venue-level Events (using one or more Arenas during a window) and Memberships. Consumers can purchase memberships. Free events/memberships skip KYC.

**Deliverables:**
- `events`, `event_arenas` (join), `memberships`, `user_memberships` tables.
- Routes + Partner UI for create/edit.
- Booking flow extended for events + memberships.

**Verify:** Create a free event → bookable without KYC. Create a paid event → requires Tenant KYC verified.

**Actual outcome:** _(fill in)_

---

### Phase 16 — Audit log + Admin support tooling

**Goal:** Every financial / KYC / admin / membership action writes to `audit_log`. Admin Console can search audit log for any booking / user / tenant.

**Deliverables:**
- `audit_log` table + write helper (`writeAudit(ctx, action, entity, payload)`).
- Hooks in all financial + KYC services.
- Admin UI: timeline view per entity.

**Verify:** Issue refund → audit row written. View booking in Admin → see refund event.

**Actual outcome:** _(fill in)_

---

### Phase 17 — Integration Surface (API keys + outbound webhooks)

**Goal:** Public API documented (OpenAPI). API key auth works. Aggregator can list availability, create bookings, receive outbound webhooks on booking events. Same code path as circls.app's first-party flow — only auth + channel differ.

**Deliverables:**
- `api_keys` table — `(id, tenant_id nullable, key_hash, role, scopes jsonb, status, last_used_at, created_at)`.
- `apps/api/src/middleware/require_api_key.ts`.
- `webhook_subscriptions` table + `outbound_webhook_delivery` job.
- OpenAPI spec generation (Fastify has built-in `@fastify/swagger`).
- Documentation site (start as a static page in `apps/admin` or a separate `docs.circls.app` later).

**Verify:** Create an API key in Admin → use it to create a booking → outbound webhook fires to a test endpoint.

**Actual outcome:** _(fill in)_

---

### Phase 18 — Flutter consumer app renovation (in `circls-flutter`)

**Goal:** In the `circls-flutter` repo, rewrite the Firestore SDK calls to call our Fastify backend. OpenAPI-generated Dart client wired in. Phone-OTP login uses Firebase Auth → backend `/v1/me`.

**This phase happens in the `circls-flutter` repo, not here.** Touch points from this repo: ensure the OpenAPI spec is published as a versioned artifact (e.g., `apps/api/openapi.yaml` checked in + auto-updated by a script).

**Deliverables (in `circls-flutter`):**
- Dart OpenAPI client generated.
- All Firestore reads/writes replaced with API calls.
- Firebase SDK retained only for `firebase_auth`.

**Verify:** Consumer can browse venues, book slots, pay, manage bookings — entirely against the new backend.

**Actual outcome:** _(fill in)_

---

### Phase 19 — Production cutover

**Goal:** New platform serves real traffic. Legacy Firestore data migrated. Firebase Cloud Functions decommissioned. DNS flipped.

**Deliverables:**
- Migration script: legacy Firestore → Postgres (one-shot, run during maintenance window).
- Validation queries (row counts match, sample-record content match).
- DNS changes for `circls.app`, `admin.circls.app`, `partners.circls.app`.
- Razorpay live-mode credentials swapped in.
- Legacy Cloud Functions disabled.
- 48-hour observation window with on-call rotation.

**Verify:** A booking made on production circls.app shows up in Postgres + dashboard + Razorpay live account.

**Actual outcome:** _(fill in)_

---

## Open follow-up backlog

Captured as we go. Each item is queued for a future phase or session.

- (placeholder — appended as we discover)

## Decision log

When a decision is made *during* a phase that's not in the plan above, log it here with the phase tag.

- (placeholder)

## Notes for fresh sessions

If a future session opens this guide and you (Claude) are catching up cold:

1. Read [`docs/VISION.md`](./docs/VISION.md) and [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) **before** anything else. They contain locked decisions you'll be tempted to revisit otherwise.
2. Check `git log --oneline` to see which phases are actually done in the repo (the ✅ in this guide is an indicator, not always current).
3. Confirm the current phase with Vedant before writing any code.
4. Never auto-chain phases. The guide is for *humans following step by step*, not for autonomous build.
