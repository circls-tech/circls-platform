-- Which client a behavioural row came from: 'web' (circls.app in a browser),
-- 'android' or 'ios' (the Flutter app). Stamped from the batch the client
-- sends, not guessed from headers. Rows written before this column, and by
-- clients that do not say, stay NULL. Indexed with created_at so the admin
-- and the nightly rollups can split traffic by client over a window.
ALTER TABLE "consumer_activity" ADD COLUMN "app" text;
CREATE INDEX IF NOT EXISTS "consumer_activity_app_created_idx"
  ON "consumer_activity" ("app", "created_at");
