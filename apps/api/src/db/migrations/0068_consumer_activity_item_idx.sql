-- The admin Engagement report counts views and shares per listing, so it reads
-- consumer_activity by (item_type, item_id), optionally from a date. Only rows
-- that name a listing are indexed: heartbeats, screen views and searches carry
-- no item_id, and they are most of the table.
CREATE INDEX IF NOT EXISTS "consumer_activity_item_idx"
  ON "consumer_activity" ("item_type", "item_id", "created_at")
  WHERE "item_id" IS NOT NULL;
