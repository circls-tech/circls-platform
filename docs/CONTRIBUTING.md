# Contributing & Development Workflow

`main` is protected. **You cannot push to it directly** — every change lands via a pull
request that passes CI.

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

## Enabling branch protection (one-time, admin)
Run `bash scripts/release/protect-main.sh` as a repo admin (active gh account `VedantS01`).
Idempotent — safe to re-run. This requires `ci.yml` to be present on the default branch so
the `verify`/`db` checks are registered.
