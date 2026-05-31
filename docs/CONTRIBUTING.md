# Contributing & Development Workflow

**Every change to `main` goes through a PR that passes CI. Do not push to `main` directly.**

> **Enforcement status:** hard server-side blocking (the `protect-main` ruleset) needs
> GitHub Pro for this private repo. Until that's enabled, enforcement is **soft**:
> `.github/workflows/guard-main.yml` runs on every push to `main` and opens a loud
> `main-guard` alert issue if a commit lands without a PR. CI also runs on every push to
> `main`, so a bad direct push turns `main` red immediately. Treat a direct push as a
> process violation — open a retroactive PR or revert.

## The loop
1. Branch off `main` (or use a git worktree).
2. Make your change. Keep migrations correctly numbered (see below).
3. Open a PR to `main`. CI runs automatically.
4. When **both** checks are green — `verify` and `db` — merge. (Solo: 0 approvals required,
   so you can merge your own PR once CI passes.)

## CI (`.github/workflows/ci.yml`)
- **verify** (no DB): migration-numbering check, `pnpm -r typecheck`, `pnpm -r test`
  (unit), `pnpm -r build`.
- **db** (Postgres 18 service): applies all migrations (`pnpm --filter @circls/api
  db:migrate`), then runs the integration tests (`RUN_INTEGRATION=1`).
- There is no `lint` step — no package defines one yet. Adding ESLint is a future task.

## Migrations
Numbered `apps/api/src/db/migrations/NNNN_name.sql` with a matching `meta/_journal.json`
entry (same idx, tag, strictly-increasing `when`). Gaps are allowed (0014 is intentionally
skipped); **duplicates are not**. Because parallel branches can each grab the same next
number, treat your migration number as tentative and renumber at merge if needed. CI's
migration-numbering check (`scripts/release/check-migrations.mjs`) enforces this.

## Enabling hard branch protection (one-time, admin — needs GitHub Pro)
Once the repo is on GitHub Pro (required for rulesets/branch protection on private repos),
run `bash scripts/release/protect-main.sh` as a repo admin (active gh account `VedantS01`).
It creates/updates the `protect-main` ruleset: PR required, `verify`/`db` checks must pass,
no direct/force push, no bypass (applies to admins too). Idempotent — safe to re-run. On the
free plan it returns HTTP 403; the `guard-main.yml` soft check covers the gap until then.
