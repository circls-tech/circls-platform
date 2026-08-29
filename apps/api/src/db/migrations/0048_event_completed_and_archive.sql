-- Ending an event early, and archiving it off the partner's list.
--
-- WHY 'completed': consumers already stop seeing an event once `ends_at` has
-- passed, so "over" was purely temporal — a partner had no way to stop selling
-- BEFORE the scheduled end (event finished early, filled up off-platform, or
-- was simply called off without being "cancelled", which implies refunds).
--
-- WHY an enum value rather than an `ended_at` column: every consumer-facing
-- query already gates on `status = 'published'` (venue events, browse, detail,
-- series occurrences, and the booking guard). Leaving the published state
-- therefore hides the event everywhere with no query changes and no chance of
-- missing one. An `ended_at` column would have needed adding to all five
-- filters, where an omission fails silently — an ended event still bookable.
--
-- 'completed' is terminal and distinct from 'cancelled': cancelling implies the
-- event did not happen and attendees are refunded, whereas completing means it
-- ran and is now closed. Neither refunds anything by itself.
--
-- WHY archived_at is a column, not a status: archiving is orthogonal to the
-- lifecycle — a partner may want a cancelled, rejected, completed or abandoned
-- draft event off their list, and folding that into the status enum would lose
-- the reason the event reached its end state. It is partner-side shelving only
-- and is never consulted by a consumer query.
--
-- No backfill: existing rows keep their status, and archived_at NULL means
-- "on the list", which is today's behaviour for everything.

ALTER TYPE "event_status" ADD VALUE IF NOT EXISTS 'completed';
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "archived_at" timestamp with time zone;
--> statement-breakpoint
-- The partner list filters on this constantly; the partial index keeps the
-- default "not archived" view cheap as event volume grows.
CREATE INDEX IF NOT EXISTS "events_tenant_unarchived_idx"
  ON "events" ("tenant_id") WHERE "archived_at" IS NULL;
