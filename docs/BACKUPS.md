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
