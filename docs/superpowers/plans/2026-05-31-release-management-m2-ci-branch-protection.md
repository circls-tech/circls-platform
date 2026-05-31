# Release Management — M2: CI + Branch Protection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `main` un-pushable directly — every change lands via a PR that must pass CI (typecheck, build, unit + integration tests, and a migration-numbering check) before it can merge.

**Architecture:** A `CI` GitHub Actions workflow runs on PRs to `main` and on push to `main`, in two jobs: `verify` (no DB — migration-numbering check, typecheck, unit tests, build) and `db` (Postgres 18 service — applies all migrations cleanly, then runs the integration tests). A `protect-main.sh` script (idempotent `gh api` call) turns on branch protection requiring those two checks and a PR. The migration-numbering check is a small pure function (unit-tested locally) that catches the parallel-agent collision hazard.

**Tech Stack:** GitHub Actions, pnpm 9 + Node 24, `postgres:18` service container, drizzle migrator (`pnpm --filter @circls/api db:migrate`), vitest (`RUN_INTEGRATION=1`), `gh` CLI for branch protection, Node `node:test` for the migration-check logic.

---

## Context the implementer needs (verified facts about this repo)

- pnpm workspace, **Node 24** (`.nvmrc`), `packageManager: pnpm@9.12.0`. Apps: `@circls/api` (Fastify), `@circls/admin` `@circls/partners` `@circls/consumer` (Next.js 15). No `packages/*` are currently scaffolded.
- **Scripts that exist:** `typecheck` (all 4 apps), `build` (all 4), `test` (api + consumer only, both vitest). **No package has a `lint` script** — so CI does NOT run lint (adding ESLint is out of scope for M2). Root scripts: `pnpm -r typecheck|test|build`.
- **Integration tests** are gated by `RUN_INTEGRATION=1` + a real `DATABASE_URL` (else they self-skip). They need Postgres 18 (uses `btree_gist`, `EXCLUDE` constraints, `uuidv7()`).
- **Migrations:** `apps/api/src/db/migrations/NNNN_name.sql` + a hand-maintained `meta/_journal.json` (entries `{idx, tag, when}`). Current state: files `0000`–`0013` and `0015` (**0014 is intentionally skipped**); journal idx mirrors that with strictly-increasing `when`. So the numbering check MUST tolerate gaps but catch duplicates, file/journal mismatches, orphans, and non-increasing `when`.
- `pnpm --filter @circls/api db:migrate` runs `tsx src/migrate.ts` (drizzle migrator) and applies all pending migrations, then exits.
- **Next builds read these public env vars** (same set in all three; consumer adds Razorpay): `NEXT_PUBLIC_API_BASE_URL`, `NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_APP_ID`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`, `NEXT_PUBLIC_FIREBASE_PROJECT_ID`, `NEXT_PUBLIC_RAZORPAY_KEY_ID`. CI sets harmless dummy values so `next build` never fails on missing config.
- Repo: `VedantS01/circls-platform`. Pushing/admin requires the active `gh` account to be **VedantS01** (`gh auth switch --user VedantS01`).

**Verification reality:** CI only runs on GitHub. Tasks 2–3 (workflow + protection) cannot be executed end-to-end in this worktree; they are authored + statically validated here, and **activated on the first push/PR** (handoff). Task 1 (migration check) is fully runnable and unit-tested locally now.

---

## File structure (M2)

```
scripts/release/
  check-migrations.mjs       Pure checkMigrations() + CLI. No deps. Unit-tested. Runs in CI `verify`.
  check-migrations.test.mjs  node:test: gap-ok, duplicate, tag-mismatch, orphans, when-order, + real-repo passes.
  protect-main.sh            Idempotent `gh api` branch-protection for main. Operator-run (needs admin).
.github/workflows/
  ci.yml                     verify + db jobs; required status checks for branch protection.
docs/
  CONTRIBUTING.md            The development workflow: branch → PR → CI green → merge; how to enable protection.
```

---

## Task 1: Migration-numbering check (pure logic + CLI, TDD)

**Files:**
- Create: `scripts/release/check-migrations.mjs`
- Test: `scripts/release/check-migrations.test.mjs`

- [ ] **Step 1: Write the failing test**

`scripts/release/check-migrations.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { checkMigrations } from './check-migrations.mjs';

const j = (entries) => ({ version: '7', dialect: 'postgresql', entries });

test('valid with an intentional gap is OK (mirrors real 0014-skipped state)', () => {
  const files = ['0000_a.sql', '0002_b.sql'];
  const journal = j([
    { idx: 0, tag: '0000_a', when: 1 },
    { idx: 2, tag: '0002_b', when: 2 },
  ]);
  const r = checkMigrations(files, journal);
  assert.equal(r.ok, true, r.errors.join('; '));
});

test('duplicate migration number is rejected (the parallel-agent hazard)', () => {
  const files = ['0001_a.sql', '0001_b.sql'];
  const journal = j([{ idx: 1, tag: '0001_a', when: 1 }]);
  const r = checkMigrations(files, journal);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /duplicate migration number 0001/);
});

test('tag mismatch between file and journal is rejected', () => {
  const files = ['0001_a.sql'];
  const journal = j([{ idx: 1, tag: '0001_renamed', when: 1 }]);
  const r = checkMigrations(files, journal);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /tag/);
});

test('a .sql file with no journal entry is rejected', () => {
  const files = ['0000_a.sql', '0001_b.sql'];
  const journal = j([{ idx: 0, tag: '0000_a', when: 1 }]);
  const r = checkMigrations(files, journal);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /no _journal entry/);
});

test('a journal entry with no .sql file is rejected', () => {
  const files = ['0000_a.sql'];
  const journal = j([
    { idx: 0, tag: '0000_a', when: 1 },
    { idx: 1, tag: '0001_ghost', when: 2 },
  ]);
  const r = checkMigrations(files, journal);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /no matching \.sql/);
});

test('non-increasing "when" is rejected', () => {
  const files = ['0000_a.sql', '0001_b.sql'];
  const journal = j([
    { idx: 0, tag: '0000_a', when: 5 },
    { idx: 1, tag: '0001_b', when: 3 },
  ]);
  const r = checkMigrations(files, journal);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /strictly increasing/);
});

test('malformed filename is rejected', () => {
  const r = checkMigrations(['001_bad.sql'], j([]));
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /NNNN_name\.sql/);
});

test('the REAL repo migrations pass the check', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = join(here, '..', '..', 'apps', 'api', 'src', 'db', 'migrations');
  const files = readdirSync(dir);
  const journal = JSON.parse(readFileSync(join(dir, 'meta', '_journal.json'), 'utf8'));
  const r = checkMigrations(files, journal);
  assert.equal(r.ok, true, r.errors.join('; '));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/release/check-migrations.test.mjs`
Expected: FAIL — `Cannot find module './check-migrations.mjs'` / `checkMigrations` undefined.

- [ ] **Step 3: Write the implementation**

`scripts/release/check-migrations.mjs`:
```js
#!/usr/bin/env node
// Validates drizzle migration numbering + journal consistency. Catches the
// parallel-agent collision hazard (two branches grabbing the same NNNN). Tolerates
// intentional gaps (e.g. 0014 was skipped); rejects duplicates, file/journal
// mismatches, orphans on either side, and non-increasing "when".
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

/** @returns {{ok: boolean, errors: string[]}} */
export function checkMigrations(sqlFiles, journal) {
  const errors = [];
  const pad = (n) => String(n).padStart(4, '0');

  const parsed = sqlFiles
    .filter((f) => f.endsWith('.sql'))
    .map((f) => {
      const m = f.match(/^(\d{4})_(.+)\.sql$/);
      return m ? { num: Number(m[1]), tag: `${m[1]}_${m[2]}`, file: f } : { invalid: f };
    });
  for (const p of parsed) {
    if (p.invalid) errors.push(`migration file does not match NNNN_name.sql: ${p.invalid}`);
  }
  const files = parsed.filter((p) => !p.invalid);

  const byNum = new Map();
  for (const f of files) {
    if (byNum.has(f.num)) {
      errors.push(`duplicate migration number ${pad(f.num)}: ${byNum.get(f.num)} and ${f.file}`);
    } else {
      byNum.set(f.num, f.file);
    }
  }

  const entries = Array.isArray(journal?.entries) ? journal.entries : [];
  const byIdx = new Map();
  for (const e of entries) {
    if (byIdx.has(e.idx)) errors.push(`duplicate _journal idx ${e.idx}`);
    else byIdx.set(e.idx, e);
  }

  for (const f of files) {
    const e = byIdx.get(f.num);
    if (!e) errors.push(`migration ${f.file} has no _journal entry (idx ${f.num})`);
    else if (e.tag !== f.tag) errors.push(`_journal idx ${f.num} tag "${e.tag}" != file tag "${f.tag}"`);
  }
  for (const e of entries) {
    if (!byNum.has(e.idx)) errors.push(`_journal entry idx ${e.idx} (tag "${e.tag}") has no matching .sql file`);
  }

  const sorted = [...entries].sort((a, b) => a.idx - b.idx);
  for (let i = 1; i < sorted.length; i++) {
    if (!(sorted[i].when > sorted[i - 1].when)) {
      errors.push(
        `_journal "when" not strictly increasing: idx ${sorted[i - 1].idx} (${sorted[i - 1].when}) >= idx ${sorted[i].idx} (${sorted[i].when})`,
      );
    }
  }
  return { ok: errors.length === 0, errors };
}

// CLI entrypoint: validate the real repo migrations.
if (import.meta.url === `file://${process.argv[1]}`) {
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = join(here, '..', '..', 'apps', 'api', 'src', 'db', 'migrations');
  const files = readdirSync(dir);
  const journal = JSON.parse(readFileSync(join(dir, 'meta', '_journal.json'), 'utf8'));
  const { ok, errors } = checkMigrations(files, journal);
  if (!ok) {
    console.error('Migration check FAILED:');
    for (const e of errors) console.error('  - ' + e);
    process.exit(1);
  }
  console.log(`Migration check OK: ${files.filter((f) => f.endsWith('.sql')).length} migrations, journal consistent.`);
}
```

- [ ] **Step 4: Run the tests + the CLI to verify they pass**

Run: `node --test scripts/release/check-migrations.test.mjs`
Expected: PASS — 8 tests, 0 failures (including "the REAL repo migrations pass").

Run: `node scripts/release/check-migrations.mjs`
Expected: `Migration check OK: 14 migrations, journal consistent.`

- [ ] **Step 5: Commit**

```bash
git add scripts/release/check-migrations.mjs scripts/release/check-migrations.test.mjs
git commit -m "feat(release): migration-numbering check (pure + CLI) + tests"
```

---

## Task 2: CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Write the workflow**

`.github/workflows/ci.yml`:
```yaml
name: CI

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

permissions:
  contents: read

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  verify:
    name: verify
    runs-on: ubuntu-latest
    env:
      # Dummy DB URL so env validation passes on import; unit tests don't connect.
      DATABASE_URL: postgres://ci:ci@localhost:5432/ci
      # Dummy public config so `next build` never fails on missing env (values don't affect the build).
      NEXT_PUBLIC_API_BASE_URL: https://api.circls.app
      NEXT_PUBLIC_FIREBASE_API_KEY: ci-dummy
      NEXT_PUBLIC_FIREBASE_APP_ID: ci-dummy
      NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: ci-dummy.firebaseapp.com
      NEXT_PUBLIC_FIREBASE_PROJECT_ID: ci-dummy
      NEXT_PUBLIC_RAZORPAY_KEY_ID: ci-dummy
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - name: Migration numbering check
        run: node scripts/release/check-migrations.mjs
      - name: Typecheck
        run: pnpm -r typecheck
      - name: Unit tests
        run: pnpm -r test
      - name: Build
        run: pnpm -r build

  db:
    name: db
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:18
        env:
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: circls
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U postgres -d circls"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 20
    env:
      DATABASE_URL: postgres://postgres:postgres@localhost:5432/circls
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - name: Apply migrations (prove they run cleanly on PG18)
        run: pnpm --filter @circls/api db:migrate
      - name: Integration tests
        env:
          RUN_INTEGRATION: '1'
        run: pnpm --filter @circls/api test
```

- [ ] **Step 2: Statically validate the YAML**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml')); print('YAML OK')"`
Expected: `YAML OK`.
If `actionlint` is installed (`command -v actionlint`), run it and report; otherwise note it's unavailable.

**NOTE:** This workflow cannot be executed in the worktree — it only runs on GitHub. Its first real run is on the first PR after this branch is pushed (see Task 3 / handoff). Do NOT claim CI passed; only that the YAML is valid.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: verify + db jobs (typecheck, tests, build, migration check)"
```

---

## Task 3: Branch-protection script

**Files:**
- Create: `scripts/release/protect-main.sh`

This is operator-run (needs repo-admin). It's idempotent — safe to re-run.

- [ ] **Step 1: Write the script**

`scripts/release/protect-main.sh`:
```bash
#!/usr/bin/env bash
# Turn on branch protection for `main`: require a PR and the CI checks (verify, db)
# before merge; block direct pushes, force-pushes, and deletions. Idempotent.
# Requires: gh CLI authenticated as a repo admin (VedantS01). Run: bash scripts/release/protect-main.sh
set -euo pipefail

REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
echo "==> Protecting main on: $REPO"
echo "    (active gh account: $(gh api user -q .login))"

gh api --method PUT "repos/$REPO/branches/main/protection" \
  --input - <<'JSON'
{
  "required_status_checks": { "strict": true, "contexts": ["verify", "db"] },
  "enforce_admins": false,
  "required_pull_request_reviews": { "required_approving_review_count": 0, "dismiss_stale_reviews": true },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_linear_history": false
}
JSON

echo "✅ main is protected: PR required, checks [verify, db] must pass, no direct/force push."
echo "   Note: enforce_admins=false leaves you (admin) an emergency escape hatch."
echo "   required_approving_review_count=0 lets you merge your own PR once CI is green (solo-friendly)."
```

- [ ] **Step 2: Syntax-check**

Run: `chmod +x scripts/release/protect-main.sh && bash -n scripts/release/protect-main.sh && echo "bash -n OK"`
Expected: `bash -n OK`.
If `shellcheck` exists, run it; cosmetic warnings are acceptable, real bugs are DONE_WITH_CONCERNS.

**NOTE:** Do NOT run the script — it mutates the live repo and needs admin auth. Executing it is the operator activation step (handoff).

- [ ] **Step 3: Commit**

```bash
git add scripts/release/protect-main.sh
git commit -m "feat(release): idempotent branch-protection script for main"
```

---

## Task 4: Contributor / workflow docs

**Files:**
- Create: `docs/CONTRIBUTING.md`

- [ ] **Step 1: Write the doc**

`docs/CONTRIBUTING.md`:
```markdown
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
```

- [ ] **Step 2: Commit**

```bash
git add docs/CONTRIBUTING.md
git commit -m "docs: contributing & development workflow (PR + CI gate)"
```

---

## Definition of done (M2)

- [ ] `node --test scripts/release/check-migrations.test.mjs` passes (8/8, incl. real-repo).
- [ ] `node scripts/release/check-migrations.mjs` prints OK against the real migrations.
- [ ] `.github/workflows/ci.yml` is valid YAML with `verify` + `db` jobs.
- [ ] `scripts/release/protect-main.sh` is syntax-clean and idempotent.
- [ ] `docs/CONTRIBUTING.md` documents the gate.

**Activation (handoff — needs push + admin, not done in the worktree):**
1. Push the branch and merge it to `main` (so `ci.yml` lives on the default branch and the
   `verify`/`db` checks register on the first PR).
2. Open a throwaway PR (or the next real one) and confirm both checks run and pass — fix any
   CI surprises (most likely a Next build needing an extra dummy env, or a flaky integration
   test) before relying on the gate.
3. Run `bash scripts/release/protect-main.sh` as VedantS01 to turn on protection.

Then M2 is fully live and we plan M3 (the release pipeline).
```
