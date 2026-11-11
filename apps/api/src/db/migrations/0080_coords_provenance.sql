-- Where a listing's stored coordinates came from.
--
-- WHY: the partner map and address search can now run on Google Maps
-- (GEOCODER_PROVIDER=google). Google's terms let us keep the coordinates its
-- Geocoding and Places APIs return for at most 30 consecutive days, but the
-- place IDs indefinitely (Maps Service Specific Terms §6.3, §14.3). So a
-- venue or standalone event whose pin came from Google records the place and
-- when it was fetched, and a daily worker job (coords_refresh_service.ts)
-- re-fetches the coordinates by place ID before they expire.
--
-- Both columns are null for every existing row: those coordinates came from
-- the partner's own pin, OpenStreetMap (ODbL, storable) or the built-in
-- gazetteer, none of which expire. They stay null for a pin the partner
-- places or moves.

ALTER TABLE "venues" ADD COLUMN IF NOT EXISTS "coords_place_id" text;
--> statement-breakpoint
ALTER TABLE "venues" ADD COLUMN IF NOT EXISTS "coords_fetched_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "coords_place_id" text;
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "coords_fetched_at" timestamp with time zone;
--> statement-breakpoint
-- The refresh job's scan: only Google-sourced rows, oldest fetch first.
CREATE INDEX IF NOT EXISTS "venues_coords_fetched_at_idx" ON "venues" ("coords_fetched_at") WHERE "coords_place_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_coords_fetched_at_idx" ON "events" ("coords_fetched_at") WHERE "coords_place_id" IS NOT NULL;
