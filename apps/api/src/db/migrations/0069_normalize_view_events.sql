-- Listing views are stored as `item_view` whichever client sent them: the
-- ingest now rewrites the Flutter app's `event_view` / `venue_view` /
-- `membership_view` (any `<item_type>_view`). This brings the rows stored
-- before that into line, so the admin reports read one name.
UPDATE "consumer_activity"
   SET "event_type" = 'item_view'
 WHERE "item_type" IS NOT NULL
   AND "event_type" = "item_type" || '_view';
