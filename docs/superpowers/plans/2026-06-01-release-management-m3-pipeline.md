# Release Management — M3: Release Pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop Coolify from deploying every push to `main`; make production deploys deliberate, operator-triggered, verified against the live build SHA, and reversible — by moving prod onto a `release` branch driven by `release.yml` / `rollback.yml` / `release-candidate.yml` plus a small `scripts/release/` CLI.

**Architecture:** `main` stays the CI-gated integration branch but **stops being watched by Coolify**. A new `release` branch becomes the production branch Coolify watches; its tip is, by definition, what's live. A **release** fast-forwards `release` to a chosen (CI-green) `main` SHA and pushes — Coolify's GitHub App deploys on that push. The workflow then polls the existing `/v1/health` build SHA until prod reports the released commit, runs smoke probes, and moves a `lkg` ("last known good") tag. **Rollback** force-points `release` back to a prior SHA (honest about migrations: code reverts, schema stays forward). A scheduled **release-candidate** issue is the daily go/no-go surface. No Coolify API token is needed — the deploy is a git push; verification is the public health endpoint.

**Tech Stack:** GitHub Actions (`workflow_dispatch`, `schedule`, `actions/github-script`), `gh` CLI (check-runs query), Node 24 (`node:test`, `node:child_process`, global `fetch`), git branch/tag plumbing, the existing `/v1/health` `{ok,commit}` endpoint.

---

## Roadmap context

System milestones: **M1 Backups/DR** (done, live) · **M2 CI + branch protection** (done, soft-enforced live) · **M3 Release pipeline** *(this plan)* · **M4 Security review + test-data cleanup**.

Spec: `docs/superpowers/specs/2026-05-31-release-management-system-design.md` (§Architecture → Components 1–7, §Rollout steps 3–4, 7). This plan implements spec components 3 (`release-candidate.yml`), 4 (`release.yml`), 5 (`rollback.yml`), 7 (`scripts/release/`), and the `release`-branch + Coolify-repoint cutover, plus `docs/RELEASE.md`.

**Critical ordering / safety:** The `release` branch is created and Coolify is repointed (Task 9) **only after** all tooling has merged to `main`. At cutover, `release` tip == `main` tip == current prod SHA, so the repoint deploys identical code (no surprise ship). Until cutover, Coolify still watches `main`, so merging this M3 work auto-deploys it — but it is scripts/workflows only (no app-code change), so the deploy is inert. After cutover, `main` merges no longer deploy.

---

## File structure (M3)

```
scripts/release/
  lib.mjs                Pure helpers (no deps): parseChangedFiles, detectMigrations,
                         parseCommits, formatReleaseNotes, healthShaMatches,
                         allChecksPassed, nextReleaseTag. Unit-tested.
  lib.test.mjs           node:test unit tests for every function in lib.mjs.
  release-notes.mjs      CLI: `<base> <head>` → markdown (commits + migration flags) via git.
  detect-migrations.mjs  CLI: `<base> <head>` → newline list of migration SQL files in range.
  check-ci.mjs           CLI: reads `gh api .../check-runs` JSON on stdin → exit 1 unless all
                         REQUIRED_CHECKS are completed+success.
  release-tag.mjs        CLI: reads `git tag` on stdin, env DATE → next `release-<DATE>.N` tag.
  smoke.mjs              CLI: poll HEALTH_URL until build SHA == EXPECTED_SHA (bounded), then
                         GET each PORTAL_URLS entry asserting < 400.
  (protect-main.sh       already exists from M2 — unchanged.)
  (check-migrations.mjs  already exists from M2 — unchanged.)
.github/workflows/
  release-candidate.yml  Daily schedule + dispatch: open/update the "Release candidate <date>" issue.
  release.yml            workflow_dispatch (the go/no-go): pre-flight → ff release → verify → lkg.
  rollback.yml           workflow_dispatch: force release back to a SHA/lkg → verify, migration warning.
docs/
  RELEASE.md             Runbook: daily flow, how to release, how to roll back, cutover record.
```

**Config used by the workflows (no secrets needed):**

| Name | Where | Meaning |
|---|---|---|
| `REQUIRED_CHECKS` | release.yml env | `verify,db` — the CI check-run names that must be green on the target SHA |
| `HEALTH_URL` | release/rollback env | `https://api.circls.app/v1/health` |
| `PORTAL_URLS` | release/rollback env | `https://admin.circls.app,https://partners.circls.app,https://circls.app` |
| `GH_TOKEN` | release.yml | `${{ github.token }}` — for the check-runs API query |

The workflows push to `release` using the built-in `GITHUB_TOKEN` (`permissions: contents: write`). A token push still fires Coolify's GitHub-App webhook (the "don't re-trigger Actions" rule applies only to Actions workflow triggers, not external App webhooks), so the deploy happens. No PAT, no Coolify API token.

---

## Task 1: Pure release lib + tests (TDD)

**Files:**
- Create: `scripts/release/lib.mjs`
- Test: `scripts/release/lib.test.mjs`

- [ ] **Step 1: Write the failing test**

`scripts/release/lib.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseChangedFiles,
  detectMigrations,
  parseCommits,
  formatReleaseNotes,
  healthShaMatches,
  allChecksPassed,
  nextReleaseTag,
} from './lib.mjs';

test('parseChangedFiles: trims, drops blanks', () => {
  assert.deepEqual(parseChangedFiles('a.ts\n  b/c.sql \n\n'), ['a.ts', 'b/c.sql']);
});

test('detectMigrations: only .sql under the migrations dir', () => {
  const files = [
    'apps/api/src/db/migrations/0015_add_x.sql',
    'apps/api/src/db/migrations/meta/_journal.json',
    'apps/api/src/routes/consumer.ts',
    'apps/api/src/db/migrations/0016_y.sql',
  ];
  assert.deepEqual(detectMigrations(files), [
    'apps/api/src/db/migrations/0015_add_x.sql',
    'apps/api/src/db/migrations/0016_y.sql',
  ]);
});

test('parseCommits: splits sha<TAB>subject, tolerates no-tab line', () => {
  const out = `abc123\tfeat: a\ndef456\tfix: b\nnotab`;
  assert.deepEqual(parseCommits(out), [
    { sha: 'abc123', subject: 'feat: a' },
    { sha: 'def456', subject: 'fix: b' },
    { sha: 'notab', subject: '' },
  ]);
});

test('formatReleaseNotes: empty commits = nothing to ship', () => {
  const md = formatReleaseNotes({ baseSha: 'aaaaaaaa', headSha: 'aaaaaaaa', commits: [], migrations: [] });
  assert.match(md, /Nothing to ship/);
});

test('formatReleaseNotes: lists commits and flags migrations', () => {
  const md = formatReleaseNotes({
    baseSha: 'aaaaaaa0', headSha: 'bbbbbbb0',
    commits: [{ sha: 'bbbbbbb0', subject: 'feat: thing' }],
    migrations: ['apps/api/src/db/migrations/0017_z.sql'],
  });
  assert.match(md, /1 commit/);
  assert.match(md, /feat: thing/);
  assert.match(md, /1 migration/);
  assert.match(md, /0017_z\.sql/);
});

test('formatReleaseNotes: no migrations says so', () => {
  const md = formatReleaseNotes({
    baseSha: 'a', headSha: 'b',
    commits: [{ sha: 'b', subject: 's' }], migrations: [],
  });
  assert.match(md, /No database migrations/);
});

test('healthShaMatches: short prefix matches full, both directions', () => {
  assert.equal(healthShaMatches('{"ok":true,"commit":"abc1234def"}', 'abc1234'), true);
  assert.equal(healthShaMatches({ ok: true, commit: 'abc1234' }, 'abc1234def'), true);
});

test('healthShaMatches: mismatch / bad input is false', () => {
  assert.equal(healthShaMatches('{"ok":true,"commit":"abc1234"}', 'ffff999'), false);
  assert.equal(healthShaMatches('not json', 'abc'), false);
  assert.equal(healthShaMatches('{"ok":true}', 'abc'), false);
  assert.equal(healthShaMatches('{"commit":"abc"}', ''), false);
});

test('allChecksPassed: all required green = ok', () => {
  const json = JSON.stringify({ check_runs: [
    { name: 'verify', status: 'completed', conclusion: 'success' },
    { name: 'db', status: 'completed', conclusion: 'success' },
  ] });
  const r = allChecksPassed(json, ['verify', 'db']);
  assert.equal(r.ok, true);
});

test('allChecksPassed: a failed check fails', () => {
  const json = JSON.stringify({ check_runs: [
    { name: 'verify', status: 'completed', conclusion: 'success' },
    { name: 'db', status: 'completed', conclusion: 'failure' },
  ] });
  assert.equal(allChecksPassed(json, ['verify', 'db']).ok, false);
});

test('allChecksPassed: a missing or in-progress check fails', () => {
  const missing = JSON.stringify({ check_runs: [
    { name: 'verify', status: 'completed', conclusion: 'success' },
  ] });
  assert.equal(allChecksPassed(missing, ['verify', 'db']).ok, false);
  const running = JSON.stringify({ check_runs: [
    { name: 'verify', status: 'completed', conclusion: 'success' },
    { name: 'db', status: 'in_progress', conclusion: null },
  ] });
  assert.equal(allChecksPassed(running, ['verify', 'db']).ok, false);
});

test('allChecksPassed: keeps the newest run per name (first wins)', () => {
  // GitHub returns check-runs newest-first; an old failure must not override a new success.
  const json = JSON.stringify({ check_runs: [
    { name: 'db', status: 'completed', conclusion: 'success' },
    { name: 'db', status: 'completed', conclusion: 'failure' },
  ] });
  assert.equal(allChecksPassed(json, ['db']).ok, true);
});

test('nextReleaseTag: first of the day is .1', () => {
  assert.equal(nextReleaseTag([], '2026-06-01'), 'release-2026-06-01.1');
});

test('nextReleaseTag: increments past existing, ignores other dates/malformed', () => {
  const tags = [
    'release-2026-06-01.1',
    'release-2026-06-01.2',
    'release-2026-05-31.9',
    'release-2026-06-01.bogus',
    'lkg',
  ];
  assert.equal(nextReleaseTag(tags, '2026-06-01'), 'release-2026-06-01.3');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/release/lib.test.mjs`
Expected: FAIL — `Cannot find module './lib.mjs'`.

- [ ] **Step 3: Write the minimal implementation**

`scripts/release/lib.mjs`:
```js
// Pure helpers shared by the release CLIs. No external deps — node-only, so they run
// identically in CI, on the droplet, and locally. The I/O (git, fetch, gh) lives in the
// thin CLI wrappers; everything decision-shaped lives here and is unit-tested in lib.test.mjs.

const MIGRATIONS_PREFIX = 'apps/api/src/db/migrations/';

/** Split `git diff --name-only` / `git log --name-only` output into trimmed, non-empty paths. */
export function parseChangedFiles(text) {
  return String(text)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Migration SQL files among the changed files (the parallel-agent-collision-prone area). */
export function detectMigrations(changedFiles) {
  return changedFiles.filter(
    (f) => f.startsWith(MIGRATIONS_PREFIX) && f.endsWith('.sql'),
  );
}

/** Parse `git log --format=%H%x09%s` into [{ sha, subject }]. */
export function parseCommits(text) {
  return String(text)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const tab = l.indexOf('\t');
      return tab === -1
        ? { sha: l, subject: '' }
        : { sha: l.slice(0, tab), subject: l.slice(tab + 1) };
    });
}

/** Render the release-candidate / release-notes markdown body. */
export function formatReleaseNotes({ baseSha, headSha, commits, migrations }) {
  const lines = [`### Release candidate: \`${short(baseSha)}\` → \`${short(headSha)}\``, ''];
  if (commits.length === 0) {
    lines.push('_No new commits — `release` is already at `main`. Nothing to ship._');
    return lines.join('\n');
  }
  lines.push(`**${commits.length} commit(s) would ship:**`, '');
  for (const c of commits) lines.push(`- \`${short(c.sha)}\` ${c.subject}`);
  lines.push('');
  if (migrations.length > 0) {
    lines.push(`> ⚠️ **${migrations.length} migration(s) in this batch** — schema changes run on deploy:`);
    for (const m of migrations) lines.push(`> - \`${m}\``);
  } else {
    lines.push('_No database migrations in this batch._');
  }
  return lines.join('\n');
}

function short(sha) {
  return String(sha).slice(0, 7);
}

/** True if the live /v1/health commit matches expected (prefix-tolerant, case-insensitive). */
export function healthShaMatches(healthJson, expectedSha) {
  const data = typeof healthJson === 'string' ? safeParse(healthJson) : healthJson;
  const actual = data && typeof data.commit === 'string' ? data.commit.toLowerCase() : '';
  const expected = String(expectedSha ?? '').toLowerCase();
  if (!actual || !expected) return false;
  return actual.startsWith(expected) || expected.startsWith(actual);
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Given GitHub check-runs JSON and required check names, report whether all passed. */
export function allChecksPassed(checkRunsJson, requiredNames) {
  const data = typeof checkRunsJson === 'string' ? safeParse(checkRunsJson) : checkRunsJson;
  const runs = data && Array.isArray(data.check_runs) ? data.check_runs : [];
  const byName = new Map();
  for (const r of runs) {
    // check-runs come back newest-first; keep the first (newest) seen per name.
    if (!byName.has(r.name)) byName.set(r.name, r);
  }
  const details = requiredNames.map((name) => {
    const run = byName.get(name);
    const ok = !!run && run.status === 'completed' && run.conclusion === 'success';
    return { name, ok, status: run?.status ?? null, conclusion: run?.conclusion ?? null };
  });
  return { ok: details.every((d) => d.ok), details };
}

/** Next `release-<date>.N` tag given existing tag names and an ISO date (YYYY-MM-DD). */
export function nextReleaseTag(existingTags, dateStr) {
  const prefix = `release-${dateStr}.`;
  let max = 0;
  for (const t of existingTags) {
    if (typeof t === 'string' && t.startsWith(prefix)) {
      const n = Number(t.slice(prefix.length));
      if (Number.isInteger(n) && n > max) max = n;
    }
  }
  return `${prefix}${max + 1}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test scripts/release/lib.test.mjs`
Expected: PASS — all tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add scripts/release/lib.mjs scripts/release/lib.test.mjs
git commit -m "feat(release): pure release lib (notes, migration detect, health/CI checks, tag) + tests"
```

---

## Task 2: `release-notes` + `detect-migrations` CLIs

**Files:**
- Create: `scripts/release/release-notes.mjs`
- Create: `scripts/release/detect-migrations.mjs`

These are thin git wrappers over Task 1's pure functions.

- [ ] **Step 1: Write `release-notes.mjs`**

`scripts/release/release-notes.mjs`:
```js
#!/usr/bin/env node
// Print the release-candidate markdown for the commit range <base>..<head>.
// Usage: node scripts/release/release-notes.mjs <base-ref> <head-ref>
import { execFileSync } from 'node:child_process';
import { parseChangedFiles, detectMigrations, parseCommits, formatReleaseNotes } from './lib.mjs';

const [base, head] = process.argv.slice(2);
if (!base || !head) {
  console.error('usage: release-notes.mjs <base-ref> <head-ref>');
  process.exit(2);
}
const git = (args) => execFileSync('git', args, { encoding: 'utf8' });
const commits = parseCommits(git(['log', '--format=%H%x09%s', `${base}..${head}`]));
const migrations = detectMigrations(parseChangedFiles(git(['diff', '--name-only', `${base}..${head}`])));
process.stdout.write(formatReleaseNotes({ baseSha: base, headSha: head, commits, migrations }) + '\n');
```

- [ ] **Step 2: Write `detect-migrations.mjs`**

`scripts/release/detect-migrations.mjs`:
```js
#!/usr/bin/env node
// Print (newline-separated) the migration SQL files changed in <base>..<head>, or nothing.
// Usage: node scripts/release/detect-migrations.mjs <base-ref> <head-ref>
import { execFileSync } from 'node:child_process';
import { parseChangedFiles, detectMigrations } from './lib.mjs';

const [base, head] = process.argv.slice(2);
if (!base || !head) {
  console.error('usage: detect-migrations.mjs <base-ref> <head-ref>');
  process.exit(2);
}
const out = execFileSync('git', ['diff', '--name-only', `${base}..${head}`], { encoding: 'utf8' });
for (const m of detectMigrations(parseChangedFiles(out))) console.log(m);
```

- [ ] **Step 3: Verify both against this repo's history**

Run:
```bash
node scripts/release/release-notes.mjs HEAD~3 HEAD
node scripts/release/detect-migrations.mjs HEAD~10 HEAD
```
Expected: `release-notes` prints a "### Release candidate" block listing the last 3 commits; `detect-migrations` prints any `apps/api/src/db/migrations/*.sql` touched in the last 10 commits (possibly empty — exit 0 either way).

- [ ] **Step 4: Commit**

```bash
git add scripts/release/release-notes.mjs scripts/release/detect-migrations.mjs
git commit -m "feat(release): release-notes + detect-migrations CLIs"
```

---

## Task 3: `check-ci` + `release-tag` CLIs

**Files:**
- Create: `scripts/release/check-ci.mjs`
- Create: `scripts/release/release-tag.mjs`

- [ ] **Step 1: Write `check-ci.mjs`**

`scripts/release/check-ci.mjs`:
```js
#!/usr/bin/env node
// Gate: read `gh api repos/{repo}/commits/{sha}/check-runs` JSON on stdin and exit non-zero
// unless every REQUIRED_CHECKS entry is completed+success. Usage:
//   gh api repos/$REPO/commits/$SHA/check-runs | REQUIRED_CHECKS=verify,db node check-ci.mjs
import { allChecksPassed } from './lib.mjs';

const required = (process.env.REQUIRED_CHECKS ?? 'verify,db')
  .split(',').map((s) => s.trim()).filter(Boolean);

let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;

const { ok, details } = allChecksPassed(input || '{}', required);
for (const d of details) {
  console.log(`${d.ok ? '✓' : '✗'} ${d.name}: ${d.status ?? 'missing'}/${d.conclusion ?? '-'}`);
}
if (!ok) {
  console.error('CI is not green on the target SHA — refusing to release.');
  process.exit(1);
}
console.log('All required checks are green.');
```

- [ ] **Step 2: Write `release-tag.mjs`**

`scripts/release/release-tag.mjs`:
```js
#!/usr/bin/env node
// Compute the next `release-<DATE>.N` tag. Reads existing tags (e.g. `git tag -l`) on stdin;
// DATE env must be YYYY-MM-DD. Usage: git tag -l | DATE=2026-06-01 node release-tag.mjs
import { nextReleaseTag } from './lib.mjs';

const date = process.env.DATE;
if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error('DATE env (YYYY-MM-DD) is required');
  process.exit(2);
}
let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
const tags = input.split('\n').map((s) => s.trim()).filter(Boolean);
process.stdout.write(nextReleaseTag(tags, date) + '\n');
```

- [ ] **Step 3: Verify against synthetic input**

Run:
```bash
echo '{"check_runs":[{"name":"verify","status":"completed","conclusion":"success"},{"name":"db","status":"completed","conclusion":"success"}]}' \
  | REQUIRED_CHECKS=verify,db node scripts/release/check-ci.mjs; echo "exit=$?"
printf 'release-2026-06-01.1\nlkg\n' | DATE=2026-06-01 node scripts/release/release-tag.mjs
echo '{"check_runs":[{"name":"verify","status":"completed","conclusion":"failure"}]}' \
  | REQUIRED_CHECKS=verify,db node scripts/release/check-ci.mjs; echo "exit=$?"
```
Expected: first → prints two `✓` lines + `exit=0`; second → `release-2026-06-01.2`; third → `✗` lines + `exit=1`.

- [ ] **Step 4: Commit**

```bash
git add scripts/release/check-ci.mjs scripts/release/release-tag.mjs
git commit -m "feat(release): check-ci gate + release-tag CLIs"
```

---

## Task 4: `smoke` CLI (poll health SHA + portal probes)

**Files:**
- Create: `scripts/release/smoke.mjs`

Post-deploy verification. Polls the live `/v1/health` until its build SHA matches the released
SHA (bounded), then GETs each portal URL asserting `< 400`. `Date.now()`/`setTimeout`/`fetch`
are fine here — this is a real node CLI, not the workflow sandbox.

- [ ] **Step 1: Write the implementation**

`scripts/release/smoke.mjs`:
```js
#!/usr/bin/env node
// Post-deploy smoke: wait for live /v1/health build SHA to equal EXPECTED_SHA (bounded),
// then GET each PORTAL_URLS entry and assert < 400. Pure SHA-match logic is unit-tested in
// lib.test.mjs (healthShaMatches); this is the I/O wrapper.
//   Env: HEALTH_URL, EXPECTED_SHA, PORTAL_URLS (comma-sep),
//        HEALTH_TIMEOUT_S (default 600), POLL_INTERVAL_S (default 10)
import { healthShaMatches } from './lib.mjs';

const HEALTH_URL = process.env.HEALTH_URL ?? 'https://api.circls.app/v1/health';
const EXPECTED_SHA = process.env.EXPECTED_SHA ?? '';
const PORTAL_URLS = (process.env.PORTAL_URLS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const TIMEOUT_S = Number(process.env.HEALTH_TIMEOUT_S ?? '600');
const INTERVAL_S = Number(process.env.POLL_INTERVAL_S ?? '10');

async function getText(url) {
  const res = await fetch(url, { redirect: 'follow' });
  return { status: res.status, body: await res.text() };
}

async function waitForHealth() {
  if (!EXPECTED_SHA) {
    console.log('No EXPECTED_SHA — skipping build-SHA wait.');
    return;
  }
  const deadline = Date.now() + TIMEOUT_S * 1000;
  for (;;) {
    let body = '';
    try {
      ({ body } = await getText(HEALTH_URL));
    } catch (e) {
      body = '';
      console.log(`health fetch error: ${e.message}`);
    }
    if (body) console.log(`health: ${body.slice(0, 120)}`);
    if (healthShaMatches(body, EXPECTED_SHA)) {
      console.log(`✓ live build SHA matches ${EXPECTED_SHA.slice(0, 7)}`);
      return;
    }
    if (Date.now() > deadline) {
      console.error(`✗ timed out after ${TIMEOUT_S}s waiting for ${EXPECTED_SHA.slice(0, 7)}`);
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, INTERVAL_S * 1000));
  }
}

async function probePortals() {
  let failed = 0;
  for (const url of PORTAL_URLS) {
    try {
      const { status } = await getText(url);
      const ok = status < 400;
      console.log(`${ok ? '✓' : '✗'} ${url} → ${status}`);
      if (!ok) failed += 1;
    } catch (e) {
      console.log(`✗ ${url} → ${e.message}`);
      failed += 1;
    }
  }
  if (failed) {
    console.error(`${failed} portal probe(s) failed.`);
    process.exit(1);
  }
}

await waitForHealth();
await probePortals();
console.log('✅ Smoke passed.');
```

- [ ] **Step 2: Verify against live prod (read-only, no SHA wait)**

Run:
```bash
PORTAL_URLS='https://api.circls.app/v1/health,https://circls.app' node scripts/release/smoke.mjs
```
Expected: no SHA wait (EXPECTED_SHA empty), then `✓` lines for both URLs and `✅ Smoke passed.`
(If a portal is down this prints `✗` and exits 1 — that's correct behavior, re-run when up.)

- [ ] **Step 3: Commit**

```bash
git add scripts/release/smoke.mjs
git commit -m "feat(release): smoke CLI — poll health build SHA + portal read probes"
```

---

## Task 5: `release-candidate.yml` (daily go/no-go issue)

**Files:**
- Create: `.github/workflows/release-candidate.yml`

- [ ] **Step 1: Write the workflow**

`.github/workflows/release-candidate.yml`:
```yaml
name: Release candidate

# Opens/updates a "Release candidate <date>" issue each morning: the diff release..main,
# the migrations in the batch, and how to ship. This is the daily-sprint surface — it
# deploys nothing. Safe before the release branch exists (it skips gracefully).
on:
  schedule:
    - cron: '30 2 * * *' # 08:00 IST
  workflow_dispatch: {}

permissions:
  contents: read
  issues: write

jobs:
  candidate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }

      - name: Build release notes (release..main)
        id: notes
        run: |
          set -euo pipefail
          git fetch origin main --tags
          if ! git fetch origin release 2>/dev/null || ! git rev-parse --verify --quiet origin/release >/dev/null; then
            echo "release branch not created yet — skipping candidate." >&2
            echo "skip=true" >> "$GITHUB_OUTPUT"
            exit 0
          fi
          BASE=$(git rev-parse origin/release)
          HEAD=$(git rev-parse origin/main)
          node scripts/release/release-notes.mjs "$BASE" "$HEAD" > notes.md
          echo "head=$HEAD" >> "$GITHUB_OUTPUT"

      - name: Open or update the candidate issue
        if: steps.notes.outputs.skip != 'true'
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            const head = '${{ steps.notes.outputs.head }}';
            const body = fs.readFileSync('notes.md', 'utf8') +
              `\n\n---\n**To ship:** Actions → **Release** → Run workflow ` +
              `(target defaults to \`main\` tip \`${head.slice(0,7)}\`).\n` +
              `**To roll back:** Actions → **Rollback** → Run workflow (defaults to \`lkg\`).`;
            const today = new Date().toISOString().slice(0, 10);
            const title = `Release candidate ${today}`;
            const open = await github.rest.issues.listForRepo({
              owner: context.repo.owner, repo: context.repo.repo,
              state: 'open', labels: 'release-candidate',
            });
            const mine = open.data.find((i) => i.title === title);
            if (mine) {
              await github.rest.issues.update({
                owner: context.repo.owner, repo: context.repo.repo,
                issue_number: mine.number, body,
              });
              core.info(`Updated #${mine.number}`);
            } else {
              const created = await github.rest.issues.create({
                owner: context.repo.owner, repo: context.repo.repo,
                title, body, labels: ['release-candidate'],
              });
              core.info(`Created #${created.data.number}`);
            }
```

- [ ] **Step 2: Syntax-check the YAML**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release-candidate.yml'))" && echo OK`
Expected: `OK` (no traceback). _Full behavioral verification is the dispatch in Task 9._

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release-candidate.yml
git commit -m "ci(release): daily release-candidate issue workflow"
```

---

## Task 6: `release.yml` (the operator-triggered ship)

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Write the workflow**

`.github/workflows/release.yml`:
```yaml
name: Release

# The go/no-go. Operator-triggered. Pre-flights (target on main + CI green + prod healthy),
# fast-forwards `release` to the target SHA and pushes (Coolify deploys on that push),
# tags release-<date>.N, then verifies the live build SHA + smoke probes, and moves `lkg`.
on:
  workflow_dispatch:
    inputs:
      sha:
        description: 'main SHA to release (blank = current main tip)'
        required: false
        default: ''

permissions:
  contents: write
  issues: write

concurrency:
  group: release-prod
  cancel-in-progress: false

jobs:
  release:
    runs-on: ubuntu-latest
    env:
      REQUIRED_CHECKS: 'verify,db'
      HEALTH_URL: 'https://api.circls.app/v1/health'
      PORTAL_URLS: 'https://admin.circls.app,https://partners.circls.app,https://circls.app'
      GH_TOKEN: ${{ github.token }}
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }

      - name: Resolve target SHA
        id: target
        run: |
          set -euo pipefail
          git fetch origin main release --tags || git fetch origin main --tags
          SHA='${{ inputs.sha }}'
          if [ -z "$SHA" ]; then SHA=$(git rev-parse origin/main); fi
          SHA=$(git rev-parse "$SHA")
          echo "sha=$SHA" >> "$GITHUB_OUTPUT"
          echo "Target SHA: $SHA"

      - name: Pre-flight — target is on main and fast-forward from release
        run: |
          set -euo pipefail
          SHA='${{ steps.target.outputs.sha }}'
          git merge-base --is-ancestor "$SHA" origin/main \
            || { echo "::error::Target $SHA is not an ancestor of main"; exit 1; }
          if git rev-parse --verify --quiet origin/release >/dev/null; then
            git merge-base --is-ancestor origin/release "$SHA" \
              || { echo "::error::Not a fast-forward from release — use Rollback to move backwards"; exit 1; }
          fi

      - name: Pre-flight — CI is green on the target SHA
        run: |
          set -euo pipefail
          gh api "repos/${{ github.repository }}/commits/${{ steps.target.outputs.sha }}/check-runs" > checks.json
          node scripts/release/check-ci.mjs < checks.json

      - name: Pre-flight — prod is currently healthy
        run: |
          set -euo pipefail
          curl -fsS "$HEALTH_URL" | tee /dev/stderr | grep -q '"ok":true' \
            || { echo "::error::Prod health check failed before release"; exit 1; }

      - name: Flag migrations in this batch
        run: |
          set -euo pipefail
          SHA='${{ steps.target.outputs.sha }}'
          if git rev-parse --verify --quiet origin/release >/dev/null; then BASE=$(git rev-parse origin/release); else BASE="$SHA^"; fi
          MIGS=$(node scripts/release/detect-migrations.mjs "$BASE" "$SHA" || true)
          if [ -n "$MIGS" ]; then
            echo "::warning::This release runs migrations on deploy:"; echo "$MIGS"
          else
            echo "No migrations in this batch."
          fi

      - name: Deploy — fast-forward release and push (triggers Coolify)
        id: deploy
        run: |
          set -euo pipefail
          SHA='${{ steps.target.outputs.sha }}'
          git push origin "$SHA:refs/heads/release"
          DATE=$(date -u +%Y-%m-%d)
          TAG=$(git tag -l "release-$DATE.*" | DATE="$DATE" node scripts/release/release-tag.mjs)
          git tag "$TAG" "$SHA"
          git push origin "refs/tags/$TAG"
          echo "tag=$TAG" >> "$GITHUB_OUTPUT"
          echo "Released $SHA as $TAG"

      - name: Verify — wait for live build SHA + smoke probes
        run: EXPECTED_SHA='${{ steps.target.outputs.sha }}' node scripts/release/smoke.mjs

      - name: Mark last-known-good
        if: success()
        run: |
          set -euo pipefail
          git tag -f lkg '${{ steps.target.outputs.sha }}'
          git push -f origin refs/tags/lkg
          echo "lkg → ${{ steps.target.outputs.sha }}"

      - name: Comment success on today's candidate issue
        if: success()
        uses: actions/github-script@v7
        with:
          script: |
            const today = new Date().toISOString().slice(0, 10);
            const open = await github.rest.issues.listForRepo({
              owner: context.repo.owner, repo: context.repo.repo,
              state: 'open', labels: 'release-candidate',
            });
            const issue = open.data.find((i) => i.title === `Release candidate ${today}`);
            if (issue) {
              const tag = '${{ steps.deploy.outputs.tag }}';
              const sha = '${{ steps.target.outputs.sha }}';
              await github.rest.issues.createComment({
                owner: context.repo.owner, repo: context.repo.repo, issue_number: issue.number,
                body: `✅ Released \`${tag}\` (\`${sha.slice(0,7)}\`). lkg updated.`,
              });
            }

      - name: Alert on failure
        if: failure()
        uses: actions/github-script@v7
        with:
          script: |
            const sha = '${{ steps.target.outputs.sha }}';
            await github.rest.issues.create({
              owner: context.repo.owner, repo: context.repo.repo,
              title: `🔴 Release failed (${sha.slice(0,7)})`,
              body: [
                `Release of \`${sha}\` failed at a verification step. Prod may be mid-deploy.`,
                '',
                `Run: ${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`,
                '',
                '**If prod is unhealthy, trigger Rollback (defaults to `lkg`).**',
              ].join('\n'),
              labels: ['release'],
            });
```

- [ ] **Step 2: Syntax-check the YAML**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml'))" && echo OK`
Expected: `OK`. _Full behavioral verification is the no-op release dispatch in Task 9._

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci(release): operator-triggered Release workflow (preflight, deploy, verify, lkg)"
```

---

## Task 7: `rollback.yml`

**Files:**
- Create: `.github/workflows/rollback.yml`

- [ ] **Step 1: Write the workflow**

`.github/workflows/rollback.yml`:
```yaml
name: Rollback

# Force-points `release` back to a prior SHA (default: the `lkg` tag) and pushes — Coolify
# redeploys the older image. Verifies health + smoke. Migration-honest: if the reverted range
# carried migrations, it warns loudly — code reverts but the schema stays FORWARD; the operator
# decides any DB action. The tool never auto-reverses a forward migration.
on:
  workflow_dispatch:
    inputs:
      sha:
        description: 'SHA or tag to roll back to (blank = lkg)'
        required: false
        default: ''

permissions:
  contents: write
  issues: write

concurrency:
  group: release-prod
  cancel-in-progress: false

jobs:
  rollback:
    runs-on: ubuntu-latest
    env:
      HEALTH_URL: 'https://api.circls.app/v1/health'
      PORTAL_URLS: 'https://admin.circls.app,https://partners.circls.app,https://circls.app'
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }

      - name: Resolve rollback target
        id: target
        run: |
          set -euo pipefail
          git fetch origin main release --tags
          REF='${{ inputs.sha }}'
          if [ -z "$REF" ]; then REF=lkg; fi
          SHA=$(git rev-parse "$REF^{commit}")
          echo "sha=$SHA" >> "$GITHUB_OUTPUT"
          echo "Rollback target: $REF → $SHA"

      - name: Warn if the rollback crosses migrations
        run: |
          set -euo pipefail
          CUR=$(git rev-parse origin/release)
          SHA='${{ steps.target.outputs.sha }}'
          echo "Rolling release from $CUR back to $SHA"
          MIGS=$(node scripts/release/detect-migrations.mjs "$SHA" "$CUR" || true)
          if [ -n "$MIGS" ]; then
            echo "::warning::Rollback crosses migrations — CODE reverts but SCHEMA stays FORWARD. Affected:"
            echo "$MIGS"
          else
            echo "No migrations between target and current release."
          fi

      - name: Force release back and push (triggers Coolify redeploy)
        run: |
          set -euo pipefail
          git push -f origin '${{ steps.target.outputs.sha }}:refs/heads/release'

      - name: Verify — health build SHA + smoke probes
        run: EXPECTED_SHA='${{ steps.target.outputs.sha }}' node scripts/release/smoke.mjs

      - name: Report outcome
        if: always()
        uses: actions/github-script@v7
        with:
          script: |
            const ok = '${{ job.status }}' === 'success';
            const sha = '${{ steps.target.outputs.sha }}';
            await github.rest.issues.create({
              owner: context.repo.owner, repo: context.repo.repo,
              title: `${ok ? '✅' : '🔴'} Rollback to ${sha.slice(0,7)} ${ok ? 'succeeded' : 'FAILED'}`,
              body: [
                `Rolled \`release\` to \`${sha}\`.`,
                ok ? '' : '**Prod may still be unhealthy — investigate immediately.**',
                '',
                `Run: ${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`,
              ].join('\n'),
              labels: ['release'],
            });
```

- [ ] **Step 2: Syntax-check the YAML**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/rollback.yml'))" && echo OK`
Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/rollback.yml
git commit -m "ci(release): Rollback workflow (force release back, migration-honest, verify)"
```

---

## Task 8: `docs/RELEASE.md` runbook

**Files:**
- Create: `docs/RELEASE.md`

- [ ] **Step 1: Write the runbook**

`docs/RELEASE.md`:
```markdown
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
```

- [ ] **Step 2: Commit**

```bash
git add docs/RELEASE.md
git commit -m "docs(release): release + rollback runbook"
```

---

## Task 9: Cutover — create `release` branch, repoint Coolify, smoke the pipeline

**This task is the production cutover.** It runs **after Tasks 1–8 have merged to `main`** (via
the PR→CI flow), because the `release` branch must be created from the merged `main` tip so it
contains all the release tooling. Steps mix git (scriptable) with Coolify console actions
(operator) — each operator action has exact clicks.

- [ ] **Step 1: Confirm `main` is merged, green, and equals prod**

Run:
```bash
git fetch origin main --tags
git rev-parse origin/main
curl -fsS https://api.circls.app/v1/health
```
Expected: note the `main` SHA; `/v1/health` `commit` should already equal it (Coolify deployed
the M3 merge while still watching `main`). If they differ, wait for that deploy to finish first.

- [ ] **Step 2: Create the `release` branch at the current `main` tip and push**

Run:
```bash
git push origin origin/main:refs/heads/release
git rev-parse origin/release   # sanity: equals main
```
Expected: `release` now exists at the same SHA as `main` (== prod). No code differs, so when
Coolify is repointed it will (re)deploy identical code.

- [ ] **Step 3: OPERATOR — repoint Coolify from `main` to `release` (all four services)**

In the Coolify dashboard, for **each** of the 4 applications (`api`, `admin`, `partners`,
`consumer`):
- Open the application → **Configuration / Source** (the Git source section).
- Change **Branch** from `main` to `release`. **Save.**
- (Leave the GitHub-App connection and build settings untouched — only the watched branch changes.)

After all four are saved, trigger a redeploy of each (Coolify **Deploy** button) so they pull
from `release`. Because `release` == old `main`, this deploys the same code — a safe no-op cutover.

> If Coolify has a "deploy on push" toggle per app, confirm it stays **on** for `release` (that's
> what makes `release.yml`'s push deploy). The only change is *which branch* triggers it.

- [ ] **Step 4: Verify all four services are healthy on `release`**

Run:
```bash
PORTAL_URLS='https://api.circls.app/v1/health,https://admin.circls.app,https://partners.circls.app,https://circls.app' \
  node scripts/release/smoke.mjs
curl -fsS https://api.circls.app/v1/health   # commit should equal origin/release
```
Expected: `✅ Smoke passed.`; health `commit` == `git rev-parse origin/release`.

- [ ] **Step 5: Smoke-test the pipeline with a no-op Release dispatch**

With `release` already at the `main` tip, dispatch Release targeting that same SHA — it exercises
every workflow step without changing prod (the push is a no-op; health already matches).

Run:
```bash
gh workflow run release.yml            # blank sha = current main tip = current release tip
# wait, then:
gh run list --workflow=release.yml --limit 1
```
Expected: the run goes green — pre-flight passes (CI green on the SHA, prod healthy), the
`release-<date>.1` tag and the `lkg` tag get created, smoke passes, and it comments on (or runs
without) the candidate issue. Confirm:
```bash
git fetch origin --tags
git tag -l 'release-*' ; git rev-parse lkg
```
Expected: a `release-<today>.N` tag exists and `lkg` == the released SHA.

- [ ] **Step 6: Smoke-test the candidate workflow**

Run:
```bash
gh workflow run release-candidate.yml
gh run list --workflow=release-candidate.yml --limit 1
```
Expected: green run; an open issue titled `Release candidate <today>` exists (likely "Nothing to
ship" since `release` == `main`).

- [ ] **Step 7: Record the cutover date in the runbook and commit**

Fill the `<DATE — fill at Task 9>` placeholder in `docs/RELEASE.md` (Cutover record) with the
actual cutover date, then:
```bash
git checkout -b release-cutover-record
git add docs/RELEASE.md
git commit -m "docs(release): record M3 cutover date"
# open a PR to main as usual (this no longer deploys — main isn't watched anymore)
```

---

## Definition of done (M3)

- [ ] `node --test scripts/release/lib.test.mjs` passes (all cases).
- [ ] `scripts/release/` has `lib.mjs`, `release-notes.mjs`, `detect-migrations.mjs`,
      `check-ci.mjs`, `release-tag.mjs`, `smoke.mjs`, all verified against real input.
- [ ] `release.yml`, `rollback.yml`, `release-candidate.yml` exist, pass YAML syntax check, and
      merged to `main` via the PR→CI flow.
- [ ] `release` branch created at the `main` tip; **Coolify repointed `main → release` for all
      four services**; all four verified healthy on `release`.
- [ ] A no-op Release dispatch ran green end-to-end (pre-flight → deploy → verify → `lkg`),
      proving the wiring; `release-<date>.N` and `lkg` tags exist.
- [ ] Release-candidate dispatch ran green and produced the candidate issue.
- [ ] `docs/RELEASE.md` documents the daily flow, rollback, verification, and the cutover date.
- [ ] **Confirmed: merging to `main` no longer deploys** (Coolify watches `release`).

When all boxes are checked, M3 is done — production deploys are deliberate, verified, and
reversible — and we plan M4 (security review + test-data cleanup).
```
