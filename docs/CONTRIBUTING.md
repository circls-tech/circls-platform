# Contributing & Development Workflow

**Every change to `main` goes through a PR that passes CI. Do not push to `main` directly.**

> **Enforcement status:** the `protect-main` ruleset hard-blocks direct pushes to `main`
> and requires at least one approval from **@VedantS01** plus green `verify`/`db` checks.
> This is enforced server-side — no bypass is possible.

## The loop
1. Branch off `main` (or use a git worktree).
2. Make your change. Keep migrations correctly numbered (see below).
3. Open a PR to `main`. CI runs automatically.
4. When **both** checks are green — `verify` and `db` — and **@VedantS01 has approved**,
   the maintainer merges on their next review pass.

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

## Branch protection
The `protect-main` ruleset is active: PR required, `verify`/`db` checks must pass,
no direct/force push, no bypass (applies to admins too). The ruleset was created by running
`bash scripts/release/protect-main.sh` as a repo admin (active gh account `VedantS01`).
Idempotent — safe to re-run if the ruleset ever needs to be refreshed.

## Async working agreement

We work across timezones. To keep things moving without calls:

- **Status lives on the [Circls Delivery board](https://github.com/orgs/circls-tech/projects/1)
  (`Backlog → Ready to release → Released`) and the pinned 🚀 Release tracker — look there, don't ask.**
- **Stuck on tech (conflicts, failing checks)?** Comment `@claude …` on your PR
  (see the PR template). Don't wait on a human.
- **Need a decision or review?** Add the **`needs-vedant`** label and write the
  question on the issue/PR. @VedantS01 reviews once per day (~08:00 IST) and in
  the twice-daily Teams digest. No calls needed.
- **Only the maintainer merges.** A green PR + approval ships on the maintainer's
  next pass.
