# Deployment & Handoff

Status as of **2026-05-24**. The walk-in reception MVP backend (Track A, phases
3–10) is built, tested (26/26 integration tests against Postgres 18), and pushed
to `main`. Coolify is installed on the VPS. What remains to go live are the
**browser-only steps** (GitHub OAuth, Firebase) — listed below.

## Current state

| Thing | Where |
|---|---|
| VPS | DigitalOcean Bangalore, Ubuntu 24.04, **Coolify 4.1.0** (hardened: ufw, fail2ban, swap) |
| Coolify dashboard | http://64.227.166.240:8000 (creds in `~/circls-secrets.md`) |
| Code | github.com/VedantS01/circls-platform (private), `main` = phases 0–10 |
| API | Fastify; builds from `apps/api/Dockerfile` (port 8080, health `/v1/health/live`) |
| DB | local dev: `docker compose up`; prod: Coolify-managed PG18 (to create) |

## Go-live runbook (browser, ~20 min)

1. **Coolify dashboard HTTPS** *(optional)* — Settings → instance FQDN `https://coolify.circls.app` (DNS already points there).
2. **Connect GitHub** — Sources → GitHub App → install on `VedantS01/circls-platform`.
3. **Create Postgres 18** — `+ New → Database → PostgreSQL 18`. Internal-only by default. Copy its internal connection URL.
4. **Create the API app** — `+ New → Application` from the repo, branch `main`:
   - Build pack **Dockerfile** · Dockerfile `apps/api/Dockerfile` · base directory **`/`** (repo root) · port **8080** · health check **`/v1/health/live`** · domain **`api.circls.app`**
   - Env: `NODE_ENV=production`, `DATABASE_URL=<from step 3>`, `LOG_LEVEL=info`, `FIREBASE_SERVICE_ACCOUNT=<from step 6>`
5. **Migrations** — set the API service's post-deploy command to **`node dist/migrate.js`** (or run once in the container terminal). Creates all tables incl. `btree_gist` + the booking exclusion constraint.
6. **Firebase** — create a project (or reuse stage); enable **Phone (OTP)** + **Email/Password**; Project Settings → Service accounts → generate a private-key JSON; put it (raw or base64) in `FIREBASE_SERVICE_ACCOUNT`. Admin endpoints need an `admin: true` custom claim on internal staff (set via the Admin SDK).
7. **Deploy + verify**:
   - `curl https://api.circls.app/v1/health` → `{"ok":true}`
   - `GET /v1/me` with a Firebase ID token → the user row.

## Local development

```bash
docker compose up -d --wait                       # Postgres 18 on :5433
export DATABASE_URL=postgres://postgres:postgres@localhost:5433/circls
pnpm --filter @circls/api db:migrate              # apply migrations
pnpm --filter @circls/api dev                     # API on :8080
RUN_INTEGRATION=1 pnpm --filter @circls/api test  # integration tests (needs the DB)
```

## Env vars

| Var | Required | Default | Notes |
|---|---|---|---|
| `DATABASE_URL` | yes | — | postgres connection string |
| `FIREBASE_SERVICE_ACCOUNT` | for auth | — | service-account JSON (raw or base64) |
| `PORT` | no | 8080 | |
| `LOG_LEVEL` | no | info | |
| `NODE_ENV` | no | development | set `production` in prod |
| `RESEND_API_KEY` | for email | — | Resend server key (`re_…`). Unset ⇒ email runs in stub mode. See `docs/EMAIL_SETUP.md`. |
| `RESEND_FROM` | with key | — | verified sender, e.g. `Circls <no-reply@circls.app>`. Required alongside the key. |
| `R2_ACCOUNT_ID` | for media | — | Cloudflare R2 account id (hex prefix of the S3 endpoint). Unset ⇒ storage stub mode. |
| `R2_ACCESS_KEY_ID` | for media | — | R2 API token S3 access key id. |
| `R2_SECRET_ACCESS_KEY` | for media | — | R2 API token S3 secret. |
| `R2_BUCKET` | for media | — | `circls-media` (public venue-media bucket). |
| `R2_PUBLIC_BASE_URL` | for media | — | bucket public URL, e.g. `https://pub-….r2.dev`. Venue-image URLs are built from this. |
| `RAZORPAY_KEY_ID` | **prod: yes** | — | Razorpay dashboard → Settings → API Keys. Boot fails in production without all three Razorpay vars; unset in dev ⇒ payment stub mode. |
| `RAZORPAY_KEY_SECRET` | **prod: yes** | — | Shown once when the key is generated. |
| `RAZORPAY_WEBHOOK_SECRET` | **prod: yes** | — | Set when creating the webhook (Settings → Webhooks → `https://api.circls.app/webhooks/razorpay`). |
| `STRIPE_SECRET_KEY` | for US venues | — | Stripe dashboard → Developers → API keys (`sk_live_…`). The three Stripe vars are **all-or-nothing**: unless ALL are set, Stripe runs in stub mode (US-venue bookings are reserved, never charged) and a partial config logs `stripe_partially_configured_using_stub`. |
| `STRIPE_PUBLISHABLE_KEY` | for US venues | — | Same page (`pk_live_…`) — returned to the browser to open the payment form. |
| `STRIPE_WEBHOOK_SECRET` | for US venues | — | Developers → Webhooks (newer UI: Event destinations → **Add destination**, type "Webhook endpoint") → URL `https://api.circls.app/webhooks/stripe` with events `payment_intent.succeeded`, `payment_intent.payment_failed`, `refund.updated`, `refund.failed`; then reveal the destination's signing secret (`whsec_…`). |
| `INR_PAYMENT_GATEWAY` | no | Cashfree once both Cashfree keys are set, else `razorpay` | Forces the **default** gateway for new INR orders: `razorpay` or `cashfree`. Platform admins override it without a restart on the admin console's **Payments** page (stored in the `platform_settings` table, picked up within ~15 s). Switching is safe mid-flight: refunds, cancels and webhooks always use the provider stored on each charge, so keep **both** gateways configured while either still holds refundable payments. |
| `CASHFREE_CLIENT_ID` | when INR → cashfree | — | Cashfree Merchant Dashboard → Payment Gateway → Developers → API Keys (App ID). Both Cashfree keys must be set or it runs in stub mode; boot fails in production if `INR_PAYMENT_GATEWAY=cashfree` without them, and the Payments page won't switch INR to a gateway without keys. |
| `CASHFREE_CLIENT_SECRET` | when INR → cashfree | — | Same page. Also verifies webhooks — Cashfree signs them with this secret, so there's no separate webhook secret. Webhook URL (Developers → Webhooks, subscribe to payment success/failed/user-dropped + refund status): `https://api.circls.app/webhooks/cashfree`. |
| `CASHFREE_ENV` | when INR → cashfree | `sandbox` | `sandbox` or `production` — picks the API host and the browser SDK mode; must match the keys. Boot fails in production if Cashfree is configured and this isn't `production`. The local sandbox pins `sandbox`. |
| `GATEWAY_HTTP_TIMEOUT_MS` | no | `10000` | Timeout for each Razorpay, Stripe and Cashfree API call. A Cashfree order that times out is retried on Razorpay. |
| `INR_FAILOVER_THRESHOLD` | no | `3` | Automatic failover: after this many Cashfree outages (timeouts, network errors, 5xx, 429)… |
| `INR_FAILOVER_WINDOW_SEC` | no | `300` | …within this window, new INR orders skip Cashfree… |
| `INR_FAILOVER_COOLDOWN_SEC` | no | `600` | …for this long, then Cashfree is tried again. Kept in the API process's memory (a restart resets it); the admin **Payments** page shows it and can end it early. |
| `GEOCODER_PROVIDER` | no | `stub` | `stub` resolves + searches venue addresses against a built-in India/USA city gazetteer (no external calls). Set `photon` in prod to geocode arbitrary addresses **and power the address autocomplete** via OpenStreetMap Photon (free/keyless; ODbL permits storing results; built for type-ahead). |
| `GEOCODER_BASE_URL` | no | `https://photon.komoot.io` | Photon endpoint. Point at a self-hosted instance if you outgrow the public one's fair-use limits. |
| `GEOCODER_USER_AGENT` | with photon | `circls-platform/1.0 (+https://circls.app)` | Identifies the app per OSM policy — app name + a contact URL. |
| `LISTING_PREVIEW_SECRET` | **prod: yes** | random per process (dev/test only) | Signs the short-lived "preview as a customer" links partners and reviewers open for unapproved listings (`/v1/tenants/…/listings/:type/:id/preview`, `/v1/admin/listings/:type/:id/preview`). Any long random string (≥ 16 chars). Boot fails in production without it: every instance must verify what any instance minted. Dev/test fall back to a per-process secret, so links there stop working on restart. |
| `CONSUMER_BASE_URL` | no | `https://circls.app` | Where the consumer site lives. Preview links, question-notification emails and the Cashfree return URL are built from it. |

## Moving Indian payments to Cashfree

Razorpay stays configured as the backup. Customers pay the same fee on either
gateway. Cashfree becomes the default as soon as both of its keys are on the
API service, so finish the dashboard setup before adding them.

Only the website moves: the API gives a checkout a Cashfree order only when
the client lists Cashfree in its `X-Checkout-Gateways` header. The website does;
current app builds don't, so the app keeps paying through Razorpay. An app
build moves over by sending that header, once it supports Cashfree and its
Google Play / App Store listing is whitelisted (Cashfree whitelists apps by
store link).

1. **Cashfree Merchant Dashboard → Payment Gateway, in production mode:**
   - **Developers → Whitelisting → Add New:** `https://circls.app` (and
     `https://www.circls.app` if the site is also reached through www); the
     app's Google Play and App Store links come later, with its Cashfree
     build. Each entry is reviewed, usually within 24 hours, and live
     checkout won't open from anywhere unlisted. The review looks for Contact,
     Terms and Refund pages and INR prices on the site.
   - **Developers → Webhooks → Add Webhook Endpoint:** URL
     `https://api.circls.app/webhooks/cashfree`, webhook version **2026-01-01**
     (the latest), and the events Success Payment, Failed Payment, User Dropped
     Payment and Refund (whichever are listed). There's no separate webhook
     secret: Cashfree signs with the API key's secret, so the endpoint's
     **Test** only passes once the keys are live on the API.
   - On that endpoint, set the **retry policy** to *Fixed*: 10 retries, 30
     minutes apart. The default gives up after 3 retries (about 40 minutes).
     The API also polls Cashfree every 5 minutes (payments for 48 hours,
     refunds for 30 days), so a missed webhook still lands, just later.
   - **Developers → API Keys → Generate API Keys** (OTP; available once the
     gateway is activated) gives the **App ID** and **Secret Key**.
2. **Coolify (API service):** set `CASHFREE_CLIENT_ID` (the App ID),
   `CASHFREE_CLIENT_SECRET` (the Secret Key) and `CASHFREE_ENV=production`, keep
   all three `RAZORPAY_*` vars, and make sure `INR_PAYMENT_GATEWAY` isn't set to
   `razorpay` (unless you're holding INR there). Redeploy: new Indian payments
   now go to Cashfree.
3. **Check:** admin console → **Payments** shows Cashfree as *Live · production*
   and *Taking new payments*.
4. **Smoke test:** make a small real booking, then refund it from the partner
   portal; the refund should reach *processed*.
5. **If Cashfree misbehaves:** repeated Cashfree errors move new payments to
   Razorpay on their own (see `INR_FAILOVER_*`), and a customer whose Cashfree
   payment fails can pick *Try another way to pay*, which moves their checkout
   to Razorpay. To move everyone back by hand: Payments → *Switch to Razorpay*.
   Both steps affect only new checkouts.

## Gotchas captured this session

- **PG18 Docker image:** mount the data volume at `/var/lib/postgresql` (NOT `/var/lib/postgresql/data`) — the image refuses the old layout.
- **`btree_gist` + the bookings `EXCLUDE` constraint** are applied by migration `0003` (hand-added; drizzle-kit can't express EXCLUDE).
- **`Idempotency-Key` header is required** on `POST /v1/bookings`.
- DNS is on **GoDaddy** (not Cloudflare); `api`/`coolify` A records → the droplet IP; the apex `circls.app` (legacy Firebase app) is untouched.

## Partner Portal (apps/partners)

Next.js 15 app — reception staff sign in (phone OTP) and run the desk: tenant → venue → arena → walk-in bookings.

**Run locally (fastest way to try it):**
```bash
cp apps/partners/.env.local.example apps/partners/.env.local   # prod web config + api.circls.app
pnpm --filter @circls/partners dev                              # http://localhost:3001
```
It talks to the live `api.circls.app`. Flow: log in → dashboard → create tenant → venue → arena → take walk-in bookings.

**For phone-OTP login to work** (Firebase console, project `circls-418b6`):
- Authentication → Sign-in method: enable **Phone** + **Email/Password**.
- Authentication → Settings → **Authorized domains**: `localhost` is allowed by default; add `partners.circls.app` (and any other deploy domain) before using it there.

**Deploy:** mirrors the API on Coolify (new Application from the repo). A Next.js Dockerfile for `apps/partners` (standalone output is already enabled) is a small follow-up; until then, run locally or use Coolify's Nixpacks Next.js builder.

## Still deferred

- **`@circls/api-types`** shared types package (the portal mirrors types locally for now).
- **Track B** — online payments (Razorpay), the `circls.app` consumer app, notifications, integrations.
