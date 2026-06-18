# Local Team Sandbox + PR-only Guardrails — Design

> Status: design, awaiting review. Authored 2026-06-18.

## Problem

Non-technical team members need to iterate on Circls features using Claude Code,
without any ability to harm production, real users, real money, or real messages —
and without paying GitHub for branch protection.

Two distinct needs, solved by two parts of this design:

1. **A sandbox to build in.** Each member needs a full, prod-like Circls stack they
   can run, break, and reset on their own machine — with all third-party services
   simulated locally (auth OTPs shown to them, fake payments, captured emails).
2. **A wall that keeps their work as PRs only.** Their Claude Code sessions must
   *physically cannot* push to `main` or `release`. This is a production-safety
   control, not git hygiene: per `docs/RELEASE.md`, Coolify auto-deploys the
   `release` branch to production, so an accidental push to `release` is an instant
   prod deploy.

## Decisions locked (with the user, 2026-06-18)

- **Environment model:** Local per-member sandboxes only. No remote staging for now
  (the prod droplet was upgraded to 8GB; a shared remote staging can be added later
  if a demo/shareable-URL need appears — out of scope here).
- **Packaging:** Fully containerized, one command (`./sandbox up`). Only Docker
  Desktop required as a prerequisite.
- **Auth:** Firebase Auth Emulator (local, offline, OTP shown, unlimited numbers).
- **Guardrails:** Fork wall (server-side, free, unbypassable) + client-side guards
  (defense-in-depth).
- **Machines:** Apple Silicon Macs, 16GB+ RAM → full four-app stack is comfortable;
  arm64 images throughout.
- **Default app scope:** All four apps (api + partners + admin + consumer) start on
  `./sandbox up`.

## Why this shape (the reasoning, so it isn't re-litigated)

- **Local over remote.** The goal is "let non-devs and AI break things safely." A
  local per-member box gives true per-person isolation (can't touch prod, each
  other, or real side-effects), zero marginal cost, and the fastest edit→see loop
  for Claude Code. The codebase is already built for it: every third-party
  integration degrades to a **stub mode** when its keys are absent (Razorpay →
  deterministic fake orders, R2 → in-memory storage, Resend → logs instead of
  sending). The only genuinely external dependency is Firebase Auth, which the
  Auth Emulator covers fully offline.
- **Fork wall over branch protection.** GitHub branch protection / rulesets need a
  paid plan on **private** repos. The free, unbypassable equivalent is the *fork
  boundary*: a member with only read access to the canonical repo cannot push to it
  at all. A write-collaborator or fine-grained PAT can't be restricted to
  "feature branches but not main" — `contents: write` is repo-wide without paid
  rulesets. So the separate-repo boundary of a fork is the only free way to encode
  "can push my work, cannot touch upstream main/release." Client-side hooks and
  Claude deny-rules are bypassable (`--no-verify`, jailbreak, misconfig), so they
  are defense-in-depth only — never the sole control for something with prod-deploy
  blast radius.

## Part A — The local sandbox

### Components (all in `compose.sandbox.yaml`, orchestrated by a `./sandbox` wrapper)

| Service | Image / build | Purpose | Host port |
|---|---|---|---|
| `postgres` | `postgres:18` | App DB; migrations auto-run on boot | 5433 |
| `firebase-emulator` | thin `node:20-alpine` + `firebase-tools` | Auth Emulator only (no Java needed — Auth emulator is a self-contained binary; Firestore/RTDB are not used) | 9099 (auth), 4000 (UI) |
| `mailpit` | `axllent/mailpit` | Captures outbound email; shows rendered content in a web inbox | 8025 (UI), 1025 (SMTP) |
| `api` | `apps/api/Dockerfile` target, overridden to run `tsx watch` | Fastify API + worker | 8080 |
| `partners` | `apps/partners` running `next dev` | Partner portal | 3001 |
| `admin` | `apps/admin` running `next dev` | Admin console | 3002 |
| `consumer` | `apps/consumer` running `next dev` | Consumer web | 3003 |

**Dev-mode in containers (reconciles "one command" with "fast iteration").** Each app
container runs its dev server (`next dev` / `tsx watch`) with the repo **bind-mounted**,
so edits Claude Code makes on the host hot-reload inside the container. `node_modules`
and `.next` live in **named volumes** (not bind-mounted) to avoid host/container
clashes and keep file-sync fast on macOS. First `./sandbox up` runs `pnpm install`
inside the container (one-time, minutes); subsequent starts are fast.

### Third-party simulation (offline, key-free, "ignore security" as requested)

- **Firebase Auth → Auth Emulator.** Project id `demo-circls` (the emulator treats
  `demo-*` ids as offline demo projects that never reach production and need no
  credentials). Phone OTP: `signInWithPhoneNumber` against the emulator surfaces the
  verification code in the Emulator UI (`localhost:4000`) and logs — that is the
  "show them the OTP" behavior. Email/password works directly.
- **Razorpay → full stub, offline.** No keys set → backend produces deterministic
  fake orders/refunds (existing stub mode). The consumer checkout already handles
  the no-key case gracefully — it marks the booking "reserved" instead of loading
  real Razorpay JS — so nothing reaches the internet and no webhook tunnel or code
  change is required. (Alternative if they later want the real test widget:
  Razorpay test keys — explicitly out of scope for v1.)
- **R2 → in-memory stub.** Uploaded images render during a session, vanish on
  restart. (Optional later: a MinIO container for persistence — out of scope.)
- **Email → Mailpit.** A sandbox-only SMTP transport (gated by `SANDBOX_SMTP_HOST`)
  routes the app's emails to Mailpit instead of Resend; members read the rendered
  email content at `localhost:8025`.

### Required code changes (small, env-gated, invisible to prod & CI)

1. `apps/api/src/lib/firebase_admin.ts` — when `FIREBASE_AUTH_EMULATOR_HOST` is set,
   `initializeApp({ projectId })` with **no cert** instead of throwing on a missing
   `FIREBASE_SERVICE_ACCOUNT`. Prod/CI path (throw when neither is present) unchanged.
2. `apps/{partners,admin,consumer}/lib/firebase/client.ts` — call
   `connectAuthEmulator(auth, 'http://localhost:9099')` when
   `NEXT_PUBLIC_FIREBASE_USE_EMULATOR=1`. Default off. (Extract a shared helper to
   avoid three copies drifting.)
3. New `firebase.json` configuring the Auth emulator port (9099) and UI (4000).
4. Sandbox-only SMTP transport in the API's email service, gated by
   `SANDBOX_SMTP_HOST` (falls back to existing Resend/stub behavior when unset).

All three are additive and default-off — production builds and `ci.yml` behave
exactly as today. A test will assert the prod path still throws when neither service
account nor emulator host is present.

No consumer checkout change is needed: `CheckoutModal` already degrades gracefully
when the payment key is absent (stub mode) — it marks the booking "reserved" rather
than erroring. A "paid"-confirmation simulator is deferred (out of scope).

### Data — seeded and resettable

- **One seed script** (`apps/api/src/db/seed.ts` or similar) does both halves:
  - Creates known users in the **Auth Emulator** via the admin SDK pointed at the
    emulator (an admin user with the `admin: true` custom claim, a partner phone
    user, a consumer phone user).
  - Inserts the matching Postgres rows: internal tenant, a couple of demo venue
    tenants, venues, arenas, schedules, and sample bookings.
  - No PII, deterministic, reproducible.
- Members open the app to a populated, realistic state with working logins.
- `./sandbox reset` → wipe the Postgres volume + clear emulator auth state + re-run
  migrate & seed → clean state in one command after they "mess it up."

### The `./sandbox` wrapper (subcommands)

- `setup` — first-run: `gh repo fork` (sets `origin` = their fork, `upstream` =
  canonical), `git config core.hooksPath .githooks`, copy sandbox env files, build.
- `up [app...]` — start the stack (all four by default; `up partners` for a subset).
- `down` — stop.
- `reset` — wipe + reseed (above).
- `seed` — reseed without wiping volumes.
- `logs [service]` — tail logs.

A plain-language `SANDBOX.md` documents: install Docker Desktop → `gh auth login`
→ `./sandbox setup` → `./sandbox up` → open `localhost:3001` etc. → log in with the
demo OTP shown in the emulator UI → `./sandbox reset` to start clean. (Internal team
tooling — **not** partner-facing, so no Help-Centre article is required per
`CLAUDE.md`.)

## Part B — The PR-only guardrails

### The wall (server-side, free, unbypassable): fork model

- Team members are added with **read** access to `VedantS01/circls-platform` and
  **fork** it (private fork under their own account).
- Their sandbox `origin` is **their fork** (write); `upstream` is the canonical repo
  (read-only to them). PRs go fork → upstream.
- They have **no write access to upstream**, so no Claude Code session, `--no-verify`,
  jailbreak, or fat-finger can push to upstream `main` or `release`. GitHub's auth
  layer refuses it. **The user remains the sole merger.**
- Bonus: Actions on fork PRs run **without upstream secrets** by default, so a rogue
  PR cannot exfiltrate prod credentials. `ci.yml` still runs (it spins its own
  Postgres).

### Defense-in-depth (client-side, committed to the repo)

1. **`.githooks/pre-push`** (activated by `core.hooksPath` in `./sandbox setup`):
   rejects pushes to `main`/`release` on *any* remote, rejects force-pushes and
   branch deletes, prints "→ open a PR instead." Guards manual git use too.
2. **`.claude/settings.json` `deny` rules + a `PreToolUse` Bash hook**: the hook
   parses the actual git/`gh` command and blocks `git push … main/release`,
   `git merge` into protected branches, `gh pr merge`, `git push --force`, branch
   deletes. Committed, so every member's Claude Code inherits it automatically.
3. **`CLAUDE.md` sandbox section**: plain-language "only ever branch → commit → push
   to your fork → open a PR; never merge, never push to main/release." Sets intent
   (weakest layer — necessary, not sufficient).
4. **Optional backstop (separate, low priority):** upgrade `guard-main.yml` from
   alert-only to auto-revert any non-PR commit on `main`/`release` — protects against
   the user's *own* accidental pushes (the one account with write). Flagged as
   optional because auto-reverting a protected branch is itself risky.

## Out of scope (explicit YAGNI)

- Remote shared staging environment (revisit only if a demo/shareable-URL need
  arises; the upgraded prod droplet makes a 2nd Coolify env cheap to add later).
- Real Razorpay test keys / test webhooks in the local sandbox (full offline stub
  instead).
- MinIO / persistent object storage locally (in-memory stub instead).
- Per-PR ephemeral databases, per-member remote sandboxes.
- Member-vs-member git workflow beyond fork+PR (each member's fork is their own
  isolation; coordination is via PRs the user reviews).

## Testing / verification

- `./sandbox up` brings all services healthy; `localhost:3001/3002/3003` load and
  `localhost:8080/v1/health` returns ok.
- Log in to partners via emulator phone OTP (code visible in Emulator UI); create a
  booking; confirm it persists.
- Trigger an email path; confirm the rendered email appears in Mailpit.
- Run a consumer checkout; confirm the offline shim completes payment.
- `./sandbox reset` returns to the seeded baseline.
- **Guardrail tests:** from a member-simulating clone, `git push origin main` and
  `git push upstream main` both fail (hook + lack of upstream write); `gh pr merge`
  is blocked by the Claude hook; a normal feature-branch push to the fork + PR
  succeeds.
- **Prod-safety regression:** `pnpm -r typecheck`, unit tests, and `ci.yml`
  integration tests pass unchanged; the prod firebase path still throws when neither
  service account nor emulator host is set.

## Build order (for the implementation plan)

1. Env-gated code changes (firebase_admin emulator branch, frontend
   `connectAuthEmulator` helper, SMTP→Mailpit transport, consumer checkout shim) +
   regression tests proving prod/CI unaffected.
2. `firebase.json` + `compose.sandbox.yaml` + the `./sandbox` wrapper (dev-mode
   containers, bind mounts, named volumes, profiles).
3. Seed script (emulator users + Postgres demo data) + `reset`.
4. Guardrails: `.githooks/pre-push`, `.claude/settings.json` deny-rules +
   `PreToolUse` hook, `CLAUDE.md` sandbox section, fork bootstrap in `./sandbox setup`.
5. `SANDBOX.md` onboarding doc; end-to-end verification + guardrail tests.
6. (Optional) `guard-main.yml` auto-revert backstop.
