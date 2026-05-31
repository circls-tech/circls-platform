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
