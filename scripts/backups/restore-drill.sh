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
