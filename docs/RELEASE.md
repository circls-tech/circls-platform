# Release Runbook

Production runs off the **`release`** branch. Coolify watches `release` for all four services
(`api`, `admin`, `partners`, `consumer`) and deploys on every push to it. **`main` is the
CI-gated integration branch and is NOT watched by Coolify** — merging to `main` ships nothing.
The tip of `release` is, by definition, what is live.

## Daily flow
1. Each morning the **Release candidate** workflow opens/updates a `Release candidate <date>`
   issue: the `release..main` diff (what would ship) and any migrations in the batch.
2. Review it. When you want to ship: **Actions → Release → Run workflow** (leave `sha` blank to
   release the current `main` tip, or paste a specific `main` SHA).
3. The Release workflow pre-flights (target on `main`, CI green on that SHA, prod currently
   healthy), fast-forwards `release` to the target and pushes (Coolify deploys), tags
   `release-<date>.N`, waits for `/v1/health` to report the new build SHA, runs smoke probes,
   and moves the `lkg` ("last known good") tag. It comments the result on the candidate issue.

## Rolling back
- **Actions → Rollback → Run workflow.** Leave `sha` blank to roll back to `lkg` (the last
  verified-good release), or pass a specific SHA/tag.
- It force-points `release` back and pushes; Coolify redeploys the older image; it verifies
  health + smoke.
- **Migrations are one-way.** If the rolled-back range included a migration, the workflow warns:
  the *code* reverts but the *schema stays forward*. That is usually safe (additive migrations).
  If a migration was destructive/incompatible, restore from backup (`docs/BACKUPS.md`) — the tool
  never auto-reverses a forward migration.

## Tags
- `release-<YYYY-MM-DD>.N` — every successful release, in order.
- `lkg` — moving tag pointing at the most recent **verified** release. Rollback defaults here.

## How a deploy is verified
`/v1/health` returns `{ ok, commit }` where `commit` is the build SHA (Coolify injects
`SOURCE_COMMIT` at image build). The Release/Rollback workflows poll it until it equals the
released SHA (bounded timeout), then probe each portal returns `< 400`. A timeout or a portal
failure fails the workflow and (for Release) opens an alert issue suggesting rollback.

## Why this exists / what changed
Previously Coolify deployed every push to `main`, with no pre-flight and no tracked rollback.
Now releases are deliberate, operator-approved, CI-gated, verified, and reversible. See the
design spec: `docs/superpowers/specs/2026-05-31-release-management-system-design.md`.

## Local CLI (the workflows reuse these; you can run them by hand)
- `node scripts/release/release-notes.mjs <base> <head>` — preview what would ship.
- `node scripts/release/detect-migrations.mjs <base> <head>` — list migrations in a range.
- `node scripts/release/smoke.mjs` — `EXPECTED_SHA=… HEALTH_URL=… PORTAL_URLS=…` to probe prod.

## Cutover record
- `release` branch created from `main` and Coolify repointed `main → release` for all four
  services on **<DATE — fill at Task 9>**. Pipeline smoke-tested with a no-op release dispatch.
