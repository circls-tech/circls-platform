-- Membership enrichment (PR #110). Adds optional `terms` text and a single
-- `cover_storage_key` artwork object key, and coerces the opaque `benefits` blob
-- into the typed `{ items: [{ label, detail? }] }` shape — without data loss.
-- Migration number to be reconciled at merge.

ALTER TABLE "memberships" ADD COLUMN "terms" text;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "cover_storage_key" text;--> statement-breakpoint

-- Backfill: coerce legacy benefits blobs into { items: [...] }.
--   * already-typed ({items:...})  → left untouched
--   * array (string[] or object[]) → each element becomes an item label
--   * non-empty object             → each key/value becomes a label/detail pair
--   * anything else / empty / null → { items: [] }
UPDATE "memberships" m
SET "benefits" = sub.new_benefits
FROM (
  SELECT
    id,
    CASE
      WHEN benefits ? 'items' THEN benefits
      WHEN jsonb_typeof(benefits) = 'array' THEN
        jsonb_build_object('items', COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'label',
              CASE WHEN jsonb_typeof(e) = 'string' THEN (e #>> '{}') ELSE e::text END
            )
          )
          FROM jsonb_array_elements(benefits) AS e
        ), '[]'::jsonb))
      WHEN jsonb_typeof(benefits) = 'object' AND benefits <> '{}'::jsonb THEN
        jsonb_build_object('items', COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'label', kv.key,
              'detail',
              CASE WHEN jsonb_typeof(kv.value) = 'string' THEN (kv.value #>> '{}') ELSE kv.value::text END
            )
          )
          FROM jsonb_each(benefits) AS kv
        ), '[]'::jsonb))
      ELSE jsonb_build_object('items', '[]'::jsonb)
    END AS new_benefits
  FROM "memberships"
) sub
WHERE m.id = sub.id;--> statement-breakpoint

-- Lock in the new default shape for future inserts.
ALTER TABLE "memberships" ALTER COLUMN "benefits" SET DEFAULT '{"items":[]}'::jsonb;
