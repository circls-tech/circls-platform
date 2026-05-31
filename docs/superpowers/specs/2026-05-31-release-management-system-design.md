# Circls Release Management System — Design

**Date:** 2026-05-31
**Status:** Approved (design); implementation pending
**Owner:** Release management (Claude, on behalf of operator)
**Context:** MVP launch hardening for the Circls platform.

## Problem

The platform runs on self-hosted Coolify (DigitalOcean droplet, Bangalore) serving
`api.circls.app`, `admin.circls.app`, `partners.circls.app`, and `circls.app`
(consumer), backed by a Coolify-managed Postgres 18. Today **Coolify auto-deploys
every push to `main`** and auto-runs migrations. There is:

- **No CI** — nothing runs `typecheck`/`lint`/`test`/`build` before code reaches prod.
- **No branch protection** — direct pushes to `main` are allowed and each one ships.
- **No database backups / DR** — a bad migration or droplet loss = total data loss.
- **No rollback procedure** — Coolify keeps prior deploys but there's no tracked
  "last known good" or tested recovery path.
- **Test data in prod** and **known authz debt** (e.g. `admin_refunds.ts`
  `ADMIN_USER_IDS` backdoor, `computeCommissionPaise()` TODO).

We need a systematic, low-risk release process for the MVP: pushes to `main` blocked,
releases deliberate and verified, with backups and rollback.

## Goals

1. Block direct pushes to `main`; all changes land via PR with green CI.
2. Make production deploys **deliberate and operator-approved**, on a **daily sprint**
   cadence, with pre-flight checks and post-deploy verification.
3. Provide **database backups + DR** with a tested restore drill (this is the
   launch-blocker and ships first).
4. Provide a **rollback** path that is honest about migration semantics.
5. Run a **security review** and **clean test data** before real users arrive.

## Non-goals (v1)

- **Mobile store releases.** The Flutter consumer app (`circls` repo) ships via
  App Store / Play Store — a different release track (store review, no instant
  rollback). Excluded from v1; addressed separately when the app is store-bound.
- Blue/green or canary deploys. Coolify does rolling redeploys; that's sufficient
  for MVP. Revisit if traffic warrants.
- Multi-environment (staging) promotion pipeline. We have one prod target. A staging
  tier can be layered on later using the same `release`-branch mechanism.

## Decisions (locked)

| Decision | Choice |
|---|---|
| Deploy topology | **Release branch.** `main` protected; Coolify watches a new `release` branch. |
| Release cadence | **Operator-approved daily.** Tool prepares the candidate; human triggers the ship. |
| Approval mechanism | **Manual `workflow_dispatch`** (no paid GitHub environment reviewer gate). |
| First deliverable | **Backups/DR**, before the pipeline. |
| Scope | **Platform only** (API + 3 web apps on Coolify). Mobile excluded. |

## Architecture

### Git flow

```
feature branch ──PR──▶ main (protected, CI-gated, never auto-deploys)
                         │
                         │  release tool: fast-forward release → vetted main SHA, push
                         ▼
                       release ──(Coolify GitHub app)──▶ prod deploy + auto-migrate
```

- **`main`** — integration branch. Protected: PR required, `ci` status check required,
  no force-push, no direct push. Merging here is safe and ships nothing.
- **`release`** — production branch. **Coolify is repointed to watch `release`** for all
  four services. The tip of `release` is, by definition, what is in production.
- A **release** fast-forwards `release` to a chosen `main` SHA and pushes. Coolify's
  GitHub app deploys on that push. **No Coolify API token is needed in CI** for the
  deploy itself; post-deploy verification uses the public `/v1/health` endpoint.
- Each release is tagged `release-YYYY-MM-DD.N`. The most recent successfully-verified
  release is the **last-known-good (LKG)**, recorded as a moving git tag `lkg` and in
  the release-candidate issue thread.

### Components

1. **`ci.yml`** (GitHub Actions) — runs on PRs to `main` and on push to `main`:
   - `pnpm install --frozen-lockfile`
   - `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test`, `pnpm -r build`
   - **Migration check** job: spin up Postgres 18 service, run all migrations from
     clean, assert they apply in one transaction without error, and assert migration
     numbering is contiguous / non-colliding (guards the parallel-agent migration
     gotcha). Integration tests (`RUN_INTEGRATION=1`) run here against that PG.
   - This is the required status check that enforces "blocked push to main".

2. **Branch protection** (configured via `gh api`, captured as a documented,
   re-runnable script in `scripts/release/`):
   - Require PR before merge, require `ci` to pass, dismiss stale approvals,
     block force-push and direct push to `main`.

3. **`release-candidate.yml`** (scheduled, daily, early IST) — opens/updates a
   **"Release candidate YYYY-MM-DD" GitHub issue** containing:
   - the `release..main` commit diff (what would ship),
   - the list of migrations in the batch (flagged prominently if any),
   - a go/no-go checklist,
   - a link to trigger `release.yml`.
   This is the "daily sprint" surface. No deploy happens here.

4. **`release.yml`** (`workflow_dispatch`, operator-triggered = the go/no-go):
   - Input: target `main` SHA (default: current `main` tip).
   - **Pre-flight:** confirm CI is green on the target SHA; migration dry-run against
     a throwaway PG; confirm current prod is healthy before touching it.
   - **Deploy:** fast-forward `release` to the target SHA, push (triggers Coolify),
     create the `release-YYYY-MM-DD.N` tag.
   - **Verify:** poll `/v1/health` until the live build SHA equals the released SHA
     (bounded timeout), then run **smoke tests** (API health + a read path per portal).
   - **On green:** move the `lkg` tag, comment success on the candidate issue.
   - **On red:** trigger auto-rollback (see below) and report failure.

5. **`rollback.yml`** (`workflow_dispatch`):
   - Input: target SHA (default: previous release tag / `lkg`).
   - Force-points `release` to the target, pushes (Coolify redeploys the prior image),
     verifies `/v1/health` SHA + smoke tests.
   - **Migration honesty:** if the release being rolled back carried a migration, the
     workflow surfaces a prominent warning — code is reverted but the schema stays
     forward; the affected migration is named and the operator decides on any DB action.
     The tool never silently attempts to reverse a forward migration.

6. **`/v1/health` build SHA — already in place.** `apps/api/src/routes/health.ts`
   returns `{ ok: true, commit: <SOURCE_COMMIT> }`, injected at Docker build time (Coolify
   sets the `SOURCE_COMMIT` build arg; the Dockerfile promotes it to a runtime env). This
   is what makes deploy verification and rollback real rather than route-existence probing.
   The release tool consumes it; no work needed here.

7. **`scripts/release/`** — small Node/TS CLI shared by the workflows and usable locally:
   - `release-notes` (diff `release..main`, migration list),
   - `smoke` (health + per-portal read probes),
   - `protect-main` (idempotent branch-protection setup),
   - `detect-migrations` (does this range touch `apps/api/src/db/migrations/`?).

### Backups / DR (first deliverable — ships before the pipeline)

You cannot launch with zero backups. Deliver backlog #50:

- **Daily Postgres backup** → off-box object storage. Cloudflare R2 bucket
  `circls-backups`, wired into Coolify's managed-Postgres scheduled-backup feature
  (region `auto`, daily).
- **DO droplet backup** add-on enabled (whole-box, weekly) as a coarse second layer.
- **Restore drill** — a script that pulls the latest dump and restores it into a
  throwaway Postgres to *prove recoverability*. An untested backup is not a backup.
  Run once at setup and on a recurring schedule.
- **Freshness monitor** — alert if no new backup has landed in 24h.

**Operator/console steps** (not scriptable headlessly; precise clicks provided, or run
via `!`): create the R2 bucket + S3 API token, add it under Coolify → Settings → S3
Storages, enable the managed-PG backup schedule, enable the DO droplet backup add-on.
Everything scriptable (restore drill, freshness monitor, verification) is scripted.

### Security review + test-data cleanup (before doors open)

- **Security pass** via the `security-review` skill, reported by severity, fixed through
  the new PR pipeline. Known items to confirm/fix: `admin_refunds.ts` `ADMIN_USER_IDS`
  backdoor → capability check; Razorpay webhook HMAC verification; Firebase ID-token
  verification; secret handling (no secrets in repo/images/logs); input validation on
  consumer/public routes; `computeCommissionPaise()` returning 0; the flagged
  `acceptInvitation` uid-mismatch and silent-error-swallow follow-ups.
- **Test-data cleanup** — inventory prod for test orgs/venues/users/bookings, present the
  list for operator confirmation, then wipe — **only after a verified backup is taken.**

## Error handling & edge cases

- **Coolify deploy fails / hangs:** `release.yml` verification has a bounded timeout; on
  timeout it reports failure and offers rollback rather than hanging.
- **Health SHA never matches:** treated as a failed release → rollback path.
- **Migration fails on deploy:** Coolify's auto-migrate runs in one transaction and rolls
  back cleanly (per the documented enum-default gotcha). The deploy is then unhealthy →
  caught by verification → rollback. Migration-numbering collisions are caught earlier by
  the CI migration check.
- **Force-push protection vs. release branch:** `release` is updated by the release tool
  only; it is *not* protected against the tool's own fast-forward/rollback pushes, but
  direct human pushes to `release` are discouraged by convention and the daily flow.
- **Parallel-agent migration numbering:** CI migration check fails the PR if numbering is
  non-contiguous or duplicated, forcing a renumber before merge.

## Testing strategy

- **CI is itself the test harness** for application code (typecheck/lint/test/build +
  integration tests against real PG18).
- **Release scripts** (`scripts/release/`) get unit tests for the pure logic
  (release-notes range, migration detection, SHA parsing) and are exercised end-to-end by
  a dry-run mode that performs every step except the actual `release`-branch push.
- **Restore drill** is the test for backups: a successful restore into a throwaway PG is
  the pass criterion.
- **Smoke tests** are the post-deploy test: health SHA match + one read path per service.

## Rollout / sequencing

1. **Backups/DR** (launch-blocker) — set up, run a restore drill, confirm freshness.
2. **CI** (`ci.yml`) + **branch protection** on `main`.
3. **`release` branch** created from current `main`; **repoint Coolify** to watch it.
4. **`release.yml` / `rollback.yml` / `release-candidate.yml`** + `scripts/release/`
   (deploy verification consumes the existing `/v1/health` build SHA).
5. **Security review** + fixes through the new pipeline.
6. **Test-data cleanup** (post-verified-backup).
7. Documentation: `docs/RELEASE.md` runbook (daily flow, rollback, restore drill).

Step 4 (repoint Coolify) and the backups console wiring are the operator/browser actions;
everything else is automated or scripted. The cutover is ordered so that backups exist
before any schema-touching release flows through the new pipeline.
