-- Recurring events: occurrences created together (e.g. "every Thu & Fri until
-- Aug 30") share a series_id. Each occurrence stays a full events row — its own
-- window, scope, tiers, bookings and status — so booking/capacity/approval are
-- unchanged; series_id only groups them for publish/cancel/approve-as-one and
-- for consumer-side "one card, many dates" display. Null = standalone one-off.

ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "series_id" uuid;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_series_id_idx" ON "events" ("series_id");
