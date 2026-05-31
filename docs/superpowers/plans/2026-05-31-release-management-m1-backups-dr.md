# Release Management — M1: Backups & DR — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Circls prod Postgres a daily off-box backup, a *tested* restore path, and a freshness alarm — so the MVP can launch without risking total data loss.

**Architecture:** Coolify's managed-Postgres scheduled backup pushes a daily dump to a Cloudflare R2 bucket (S3-compatible). A **freshness monitor** runs daily in GitHub Actions reading only object *timestamps* (no data, PII-safe in CI) and fails loudly if no backup landed in 24h. A **restore drill** is a local/on-demand script that downloads the latest dump, restores it into a throwaway Postgres 18 container, and asserts the schema + key tables came back — proving the backup is actually recoverable. A second coarse layer is the DigitalOcean droplet weekly backup add-on.

**Tech Stack:** Cloudflare R2 (S3 API), Coolify managed-PG backups, GitHub Actions (`aws` CLI, preinstalled on ubuntu runners), Docker + `postgres:18`, `pg_restore`/`psql`, Node `node:test` for the pure freshness logic.

---

## Roadmap (whole system — only M1 is detailed here)

Each milestone is planned in its own file when reached, executed, verified, then the next is planned.

- **M1 — Backups & DR** *(this plan)*. Launch-blocker. Mostly ops + two small scripts.
- **M2 — CI + branch protection.** `ci.yml` (typecheck/lint/test/build + migration check); `gh api` branch protection on `main`. Blocks direct pushes.
- **M3 — Release pipeline.** Create `release` branch; repoint Coolify to it; `release.yml` / `rollback.yml` / `release-candidate.yml`; `scripts/release/`. Operator-approved daily deploys with verification (consumes the existing `/v1/health` build SHA) + rollback.
- **M4 — Security review + test-data cleanup.** `security-review` pass + fixes through the M2/M3 pipeline; inventory + wipe prod test data (after a verified backup).

Spec: `docs/superpowers/specs/2026-05-31-release-management-system-design.md`.

---

## File structure (M1)

```
scripts/backups/
  freshness.mjs          Pure isStale() + the newest-key parser. No deps. Unit-tested.
  freshness.test.mjs     node:test unit tests for isStale() and parseNewest().
  check-freshness.mjs     CLI: reads `aws s3api` JSON on stdin, calls isStale, exits 0/1.
  restore-drill.sh        Downloads latest R2 dump, restores into throwaway PG18, asserts.
.github/workflows/
  backups-monitor.yml     Daily cron: list R2 (timestamps only) → check-freshness → fail+issue if stale.
docs/
  BACKUPS.md              Runbook: how backups work, operator setup, DR restore-to-prod, the drill.
```

**Config (GitHub repo secrets + local env) — values, not placeholders.** The scripts and
workflow read these; the operator sets them once. No unknown is ever hardcoded in code:

| Name | Meaning |
|---|---|
| `R2_ENDPOINT` | `https://<account>.r2.cloudflarestorage.com` |
| `R2_BUCKET` | `circls-backups` |
| `R2_BACKUP_PREFIX` | the key prefix Coolify writes dumps under (discovered in Task 2) |
| `R2_ACCESS_KEY_ID` | R2 S3 token access key (read-only for monitor/drill) |
| `R2_SECRET_ACCESS_KEY` | R2 S3 token secret |

**GitHub secret naming:** store the two credentials as repo secrets named `R2_ACCESS_KEY_ID`
and `R2_SECRET_ACCESS_KEY`. The workflow maps them onto the env vars the `aws` CLI expects
(`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`) and sets `AWS_DEFAULT_REGION=auto`. Locally,
export them as the `AWS_*` names directly (see each script's header).

---

## Task 1: Operator setup — R2 bucket, Coolify backup schedule, DO droplet backup

**This is an OPERATOR ACTION task** (Cloudflare + Coolify + DigitalOcean consoles). No code.
Do it first: the later tasks need a real backup artifact to exist. Hand these exact steps to
the operator (or run via `!` where a CLI exists). Creds live in `~/circls-secrets.md`.

- [ ] **Step 1: Create the R2 bucket + S3 API token (Cloudflare dashboard)**
  - Cloudflare dashboard → R2 → **Create bucket** → name `circls-backups`, location `Automatic`.
  - R2 → **Manage R2 API Tokens** → **Create API token** → permissions **Object Read & Write**,
    scoped to `circls-backups`. Save the **Access Key ID**, **Secret Access Key**, and the
    **S3 endpoint** (`https://<account-id>.r2.cloudflarestorage.com`) into `~/circls-secrets.md`.

- [ ] **Step 2: Add the R2 storage to Coolify**
  - Coolify dashboard → **Settings → S3 Storages → Add**.
  - Name `r2-circls-backups`; Endpoint = the R2 S3 endpoint; Bucket `circls-backups`;
    Region `auto`; Access Key / Secret Key from Step 1. **Save**, then **Validate** (Coolify
    has a test button) — it must report success before continuing.

- [ ] **Step 3: Schedule the daily Postgres backup**
  - Coolify → the managed **PostgreSQL** resource → **Backups**.
  - **Add backup**: frequency **daily** (cron `0 2 * * *` = 02:00 server time), destination
    **S3** → `r2-circls-backups`, retention e.g. **14** days. Save.
  - Click **Backup Now** once to produce an immediate artifact (Task 2 needs it).

- [ ] **Step 4: Enable the DigitalOcean droplet weekly backup add-on**
  - DigitalOcean console → the droplet (`64.227.166.240`) → **Backups → Enable Backups**
    (weekly). This is the coarse whole-box second layer.
  - *(CLI alternative if `doctl` is authed: `doctl compute droplet-action enable-backups <droplet-id>`.)*

- [ ] **Step 5: Verify an object landed in R2**

Run (with R2 creds exported locally):
```bash
export AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… AWS_DEFAULT_REGION=auto
aws s3 ls --endpoint-url "$R2_ENDPOINT" "s3://circls-backups/" --recursive | tail
```
Expected: at least one object (the dump from Step 3's *Backup Now*), with a recent timestamp.

---

## Task 2: Capture the backup artifact facts (format + key prefix)

**Files:**
- Modify: `docs/BACKUPS.md` (create in Task 7; for now record findings in the PR description / a scratch note)

The restore drill and freshness monitor must target the *real* layout Coolify produced.
This task discovers and records two facts: the **key prefix** and the **dump format**.

- [ ] **Step 1: Find the newest object's key and prefix**

Run:
```bash
aws s3api list-objects-v2 --endpoint-url "$R2_ENDPOINT" --bucket circls-backups \
  --query 'sort_by(Contents,&LastModified)[-1].[Key,LastModified,Size]' --output text
```
Expected: one line, e.g. `backups/databases/postgresql-xyz/2026-05-31_020000.dmp 2026-05-31T02:00:01+00:00 1234567`.
Record the directory portion as `R2_BACKUP_PREFIX` (everything up to and including the last `/`).

- [ ] **Step 2: Download it and identify the format**

Run:
```bash
KEY=$(aws s3api list-objects-v2 --endpoint-url "$R2_ENDPOINT" --bucket circls-backups \
  --query 'sort_by(Contents,&LastModified)[-1].Key' --output text)
aws s3 cp --endpoint-url "$R2_ENDPOINT" "s3://circls-backups/$KEY" /tmp/circls-latest.dump
file /tmp/circls-latest.dump
# If it's gzip: gunzip -k /tmp/circls-latest.dump && file /tmp/circls-latest.dump.out
pg_restore --list /tmp/circls-latest.dump 2>&1 | head   # succeeds → custom format; errors → plain SQL
```
Expected: you can state definitively "format is **custom** (`pg_restore`)" or "**plain SQL** (`psql`)",
and whether it's gzip-compressed. Record both facts.

- [ ] **Step 3: Record the facts**

Write the discovered `R2_BACKUP_PREFIX`, format (custom/plain), and compression into the PR notes
(they become config values + are documented in `docs/BACKUPS.md` in Task 7). No code yet.

---

## Task 3: Pure freshness logic + tests (TDD)

**Files:**
- Create: `scripts/backups/freshness.mjs`
- Test: `scripts/backups/freshness.test.mjs`

- [ ] **Step 1: Write the failing test**

`scripts/backups/freshness.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isStale, parseNewest } from './freshness.mjs';

test('isStale: fresh backup (1h old) is not stale at 24h threshold', () => {
  const now = Date.parse('2026-05-31T03:00:00Z');
  assert.equal(isStale('2026-05-31T02:00:00Z', now, 24), false);
});

test('isStale: old backup (25h old) is stale at 24h threshold', () => {
  const now = Date.parse('2026-05-31T03:00:00Z');
  assert.equal(isStale('2026-05-30T02:00:00Z', now, 24), true);
});

test('isStale: missing/empty timestamp is treated as stale', () => {
  const now = Date.parse('2026-05-31T03:00:00Z');
  assert.equal(isStale(null, now, 24), true);
  assert.equal(isStale('', now, 24), true);
});

test('parseNewest: picks the latest LastModified from list-objects-v2 JSON', () => {
  const json = JSON.stringify({
    Contents: [
      { Key: 'p/a.dmp', LastModified: '2026-05-30T02:00:00Z' },
      { Key: 'p/b.dmp', LastModified: '2026-05-31T02:00:00Z' },
    ],
  });
  assert.equal(parseNewest(json), '2026-05-31T02:00:00Z');
});

test('parseNewest: empty bucket yields null', () => {
  assert.equal(parseNewest(JSON.stringify({})), null);
  assert.equal(parseNewest(JSON.stringify({ Contents: [] })), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/backups/freshness.test.mjs`
Expected: FAIL — `Cannot find module './freshness.mjs'` / exports undefined.

- [ ] **Step 3: Write the minimal implementation**

`scripts/backups/freshness.mjs`:
```js
// Pure helpers for the backup freshness check. No external deps so it runs anywhere
// (CI, droplet, local) with just node. Consumed by check-freshness.mjs.

/** True if the newest backup is older than maxAgeHours, or missing entirely. */
export function isStale(latestIso, nowMs, maxAgeHours) {
  if (!latestIso) return true;
  const t = Date.parse(latestIso);
  if (Number.isNaN(t)) return true;
  return nowMs - t > maxAgeHours * 3600 * 1000;
}

/** Newest LastModified (ISO string) from `aws s3api list-objects-v2` JSON, or null. */
export function parseNewest(jsonText) {
  const data = JSON.parse(jsonText);
  const contents = Array.isArray(data.Contents) ? data.Contents : [];
  if (contents.length === 0) return null;
  return contents
    .map((o) => o.LastModified)
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test scripts/backups/freshness.test.mjs`
Expected: PASS — 5 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add scripts/backups/freshness.mjs scripts/backups/freshness.test.mjs
git commit -m "feat(backups): pure freshness logic (isStale, parseNewest) + tests"
```

---

## Task 4: Freshness CLI wrapper

**Files:**
- Create: `scripts/backups/check-freshness.mjs`

This is the thin CLI the workflow runs. It reads `aws s3api list-objects-v2` JSON from stdin,
finds the newest timestamp, and exits non-zero if stale. Note `Date.now()` is intentional here
(runtime entrypoint, not pure logic — the pure logic in Task 3 takes `nowMs` as a param and is
what's unit-tested).

- [ ] **Step 1: Write the implementation**

`scripts/backups/check-freshness.mjs`:
```js
#!/usr/bin/env node
// Reads `aws s3api list-objects-v2 --output json` from stdin, asserts the newest
// backup is < MAX_AGE_HOURS old. Exits 1 (and prints a clear message) if stale.
// Usage: aws s3api list-objects-v2 ... --output json | node check-freshness.mjs
import { isStale, parseNewest } from './freshness.mjs';

const MAX_AGE_HOURS = Number(process.env.MAX_AGE_HOURS ?? '24');

let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;

const newest = parseNewest(input || '{}');
const now = Date.now();

if (isStale(newest, now, MAX_AGE_HOURS)) {
  console.error(
    `STALE: newest backup is ${newest ?? 'MISSING'} — older than ${MAX_AGE_HOURS}h threshold.`,
  );
  process.exit(1);
}
console.log(`OK: newest backup ${newest} is within ${MAX_AGE_HOURS}h.`);
```

- [ ] **Step 2: Verify it locally against synthetic input**

Run (fresh — should pass):
```bash
NOW=$(node -e "console.log(new Date().toISOString())")
printf '{"Contents":[{"Key":"p/x.dmp","LastModified":"%s"}]}' "$NOW" | node scripts/backups/check-freshness.mjs; echo "exit=$?"
```
Expected: prints `OK: newest backup … within 24h.`, `exit=0`.

Run (stale — should fail):
```bash
printf '{"Contents":[{"Key":"p/x.dmp","LastModified":"2020-01-01T00:00:00Z"}]}' | node scripts/backups/check-freshness.mjs; echo "exit=$?"
```
Expected: prints `STALE: …`, `exit=1`.

- [ ] **Step 3: Commit**

```bash
git add scripts/backups/check-freshness.mjs
git commit -m "feat(backups): check-freshness CLI wrapper"
```

---

## Task 5: Daily freshness-monitor workflow

**Files:**
- Create: `.github/workflows/backups-monitor.yml`

Runs daily, lists R2 object metadata only (no data download → PII-safe), runs the checker, and
**opens a GitHub issue** if the backup is stale so the failure is visible, not silent.

- [ ] **Step 1: Write the workflow**

`.github/workflows/backups-monitor.yml`:
```yaml
name: Backups Monitor

on:
  schedule:
    - cron: '0 5 * * *' # 05:00 UTC daily — a few hours after the 02:00 backup window
  workflow_dispatch: {}

permissions:
  contents: read
  issues: write

jobs:
  check-freshness:
    runs-on: ubuntu-latest
    env:
      AWS_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
      AWS_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
      AWS_DEFAULT_REGION: auto
      R2_ENDPOINT: ${{ secrets.R2_ENDPOINT }}
      R2_BUCKET: ${{ secrets.R2_BUCKET }}
      R2_BACKUP_PREFIX: ${{ secrets.R2_BACKUP_PREFIX }}
      MAX_AGE_HOURS: '24'
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 1 }

      - name: List backup objects (metadata only) and check freshness
        id: check
        run: |
          set -euo pipefail
          aws s3api list-objects-v2 \
            --endpoint-url "$R2_ENDPOINT" \
            --bucket "$R2_BUCKET" \
            --prefix "$R2_BACKUP_PREFIX" \
            --output json > objects.json
          node scripts/backups/check-freshness.mjs < objects.json

      - name: Open an issue if the backup is stale
        if: failure()
        uses: actions/github-script@v7
        with:
          script: |
            const title = `🔴 Backup freshness check failed (${new Date().toISOString().slice(0,10)})`;
            const body = [
              'The daily backup freshness check failed — no fresh Postgres backup was found in R2',
              'within the 24h threshold.',
              '',
              `Run: ${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`,
              '',
              'Check: Coolify → PostgreSQL → Backups (did the scheduled job run?), and R2 bucket contents.',
            ].join('\n');
            // Avoid duplicate spam: reuse an open issue labelled "backups" if present.
            const existing = await github.rest.issues.listForRepo({
              owner: context.repo.owner, repo: context.repo.repo,
              state: 'open', labels: 'backups',
            });
            if (existing.data.length === 0) {
              await github.rest.issues.create({
                owner: context.repo.owner, repo: context.repo.repo,
                title, body, labels: ['backups'],
              });
            }
```

- [ ] **Step 2: Add the repo secrets (OPERATOR ACTION)**

In GitHub → repo **Settings → Secrets and variables → Actions → New repository secret**, add:
`R2_ENDPOINT`, `R2_BUCKET`, `R2_BACKUP_PREFIX`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`
(use a **read-only** R2 token for these — the monitor never writes).

- [ ] **Step 3: Verify via manual dispatch**

After merge: GitHub → Actions → **Backups Monitor** → **Run workflow**.
Expected: green run, log line `OK: newest backup … within 24h.` (Confirms secrets + prefix are right.)

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/backups-monitor.yml
git commit -m "ci(backups): daily R2 backup freshness monitor"
```

---

## Task 6: Restore drill script

**Files:**
- Create: `scripts/backups/restore-drill.sh`

Downloads the newest dump, restores it into a throwaway `postgres:18` container, and asserts the
schema and key tables (`users`, `tenants`) restored. This is the *proof of recoverability*. Run
on-demand locally (and, later, on the droplet via cron) — **not** in CI, so prod data is never
pulled into GitHub Actions. Format-tolerant: handles custom (`pg_restore`) and plain (`psql`),
gzip or not.

- [ ] **Step 1: Write the script**

`scripts/backups/restore-drill.sh`:
```bash
#!/usr/bin/env bash
# Restore drill: prove the latest R2 Postgres backup is recoverable.
# Requires env: R2_ENDPOINT R2_BUCKET R2_BACKUP_PREFIX AWS_ACCESS_KEY_ID
#   AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION (=auto). Requires: aws, docker, pg client tools.
set -euo pipefail

: "${R2_ENDPOINT:?}"; : "${R2_BUCKET:?}"; : "${R2_BACKUP_PREFIX:?}"
CONTAINER=circls-drill-pg
PORT=55432
WORK=$(mktemp -d)
cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

echo "==> Finding newest backup under $R2_BACKUP_PREFIX"
KEY=$(aws s3api list-objects-v2 --endpoint-url "$R2_ENDPOINT" --bucket "$R2_BUCKET" \
  --prefix "$R2_BACKUP_PREFIX" --query 'sort_by(Contents,&LastModified)[-1].Key' --output text)
[ -n "$KEY" ] && [ "$KEY" != "None" ] || { echo "No backup found"; exit 1; }
echo "    newest: $KEY"

DUMP="$WORK/dump.bin"
aws s3 cp --endpoint-url "$R2_ENDPOINT" "s3://$R2_BUCKET/$KEY" "$DUMP"
# Decompress if gzip.
if file "$DUMP" | grep -qi gzip; then mv "$DUMP" "$DUMP.gz"; gunzip "$DUMP.gz"; fi

echo "==> Starting throwaway postgres:18 on :$PORT"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=drill -e POSTGRES_DB=drill \
  -p "$PORT:5432" postgres:18 >/dev/null
for i in $(seq 1 30); do
  docker exec "$CONTAINER" pg_isready -U postgres -d drill >/dev/null 2>&1 && break
  sleep 1
done
export PGPASSWORD=drill
URL="postgresql://postgres:drill@localhost:$PORT/drill"

echo "==> Restoring (auto-detect format)"
if pg_restore --list "$DUMP" >/dev/null 2>&1; then
  pg_restore --no-owner --no-privileges --clean --if-exists --dbname "$URL" "$DUMP" || true
else
  psql "$URL" -v ON_ERROR_STOP=0 -f "$DUMP" >/dev/null
fi

echo "==> Asserting schema restored"
TABLES=$(psql "$URL" -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
echo "    public tables: $TABLES"
[ "$TABLES" -ge 10 ] || { echo "FAIL: too few tables ($TABLES) — restore looks empty"; exit 1; }
for t in users tenants; do
  psql "$URL" -tAc "SELECT to_regclass('public.$t')" | grep -q "$t" \
    || { echo "FAIL: expected table '$t' missing after restore"; exit 1; }
  CNT=$(psql "$URL" -tAc "SELECT count(*) FROM public.$t")
  echo "    $t rows: $CNT"
done

echo "✅ RESTORE DRILL PASSED — backup $KEY is recoverable ($TABLES tables)."
```

- [ ] **Step 2: Make it executable and run it**

Run:
```bash
chmod +x scripts/backups/restore-drill.sh
export R2_ENDPOINT=… R2_BUCKET=circls-backups R2_BACKUP_PREFIX=… \
  AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… AWS_DEFAULT_REGION=auto
./scripts/backups/restore-drill.sh
```
Expected: ends with `✅ RESTORE DRILL PASSED — backup … is recoverable (N tables).`
(If it fails on format, re-check Task 2's format finding and adjust the detect branch.)

- [ ] **Step 3: Commit**

```bash
git add scripts/backups/restore-drill.sh
git commit -m "feat(backups): restore-drill — prove latest R2 dump is recoverable"
```

---

## Task 7: Runbook — docs/BACKUPS.md

**Files:**
- Create: `docs/BACKUPS.md`

- [ ] **Step 1: Write the runbook**

`docs/BACKUPS.md`:
```markdown
# Backups & Disaster Recovery

## What's backed up, where
- **Postgres (prod):** Coolify managed-PG scheduled backup → Cloudflare R2 bucket
  `circls-backups`, daily at 02:00 server time, retention 14 days.
  Key prefix: `<R2_BACKUP_PREFIX from Task 2>`. Format: `<custom|plain, gzip?>`.
- **Whole droplet:** DigitalOcean weekly Backups add-on (coarse second layer).

## Monitoring
- `.github/workflows/backups-monitor.yml` runs daily (05:00 UTC), checks the newest R2
  object is < 24h old, and opens a `backups`-labelled issue if not. Manual run: Actions →
  Backups Monitor → Run workflow.

## Restore drill (prove recoverability — run weekly / before risky deploys)
- `scripts/backups/restore-drill.sh` downloads the latest dump, restores into a throwaway
  postgres:18, and asserts the schema + `users`/`tenants` came back. Run locally with R2
  creds exported (see the script header). **PII note:** this downloads real prod data — run
  it locally or on the droplet, never in shared CI once real-user data exists.

## Disaster recovery — restoring prod for real
1. **Stop writes:** in Coolify, stop the API service (prevents partial-state writes).
2. **Get the dump:** `aws s3 cp --endpoint-url $R2_ENDPOINT s3://circls-backups/<key> ./restore.dump`.
3. **Restore into the managed PG:** open the Coolify Postgres container terminal (or connect
   with its internal URL) and run `pg_restore --no-owner --clean --if-exists --dbname "$DATABASE_URL" restore.dump`
   (or `psql -f` for a plain dump). For a fresh DB, create it first.
4. **Re-run app migrations** if the dump predates the current schema: redeploy the API
   (Coolify auto-runs `migrate.js`) or run `node dist/migrate.js` in the container.
5. **Verify:** `curl https://api.circls.app/v1/health` → `{ok:true,commit:…}`; spot-check a
   tenant/booking read.
6. **Resume writes:** start the API service.

## Operator setup (one-time) — see the M1 plan, Task 1
R2 bucket + S3 token → Coolify S3 Storages → Coolify PG Backups schedule → DO droplet Backups.
GitHub repo secrets: `R2_ENDPOINT`, `R2_BUCKET`, `R2_BACKUP_PREFIX`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY` (read-only token for the monitor).
```
Fill the `<…>` angle-bracket spots with the real values discovered in Task 2 before committing.

- [ ] **Step 2: Commit**

```bash
git add docs/BACKUPS.md
git commit -m "docs(backups): backups & DR runbook"
```

---

## Definition of done (M1)

- [ ] A backup object lands in R2 daily (verified: an object exists with a < 24h timestamp).
- [ ] `Backups Monitor` workflow runs green on dispatch and would open an issue when stale.
- [ ] `restore-drill.sh` exits `✅ PASSED` against the latest real dump (recoverability proven).
- [ ] DO droplet weekly backups enabled.
- [ ] `docs/BACKUPS.md` documents the setup, monitoring, the drill, and the DR restore procedure.
- [ ] `node --test scripts/backups/freshness.test.mjs` passes (5/5).

When all boxes are checked, M1 is done and we plan M2 (CI + branch protection).
```
