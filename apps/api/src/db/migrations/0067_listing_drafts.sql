-- Drafts for every listing type.
--
-- WHY: a partner wants to start a listing with what they have — a name, a
-- rough description — and come back for the rest. Until now a venue or a
-- plan went to review the moment it was created, and an event, though it
-- already had a 'draft' status, could not be saved without its dates and
-- location. Completeness is now checked when the partner submits for review
-- (events_service / venue_service / memberships_service), not at create.
--
-- Venues and plans get a 'draft' value in their status enums. Every consumer
-- query gates on the approved state ('active' / 'published') and the review
-- queue on 'pending_review', so a draft is invisible to both with no query
-- changes — the same reasoning as 0048's 'completed'.
--
-- Events keep their existing 'draft' status; their dates become nullable so a
-- draft can be saved without them. Readers treat a null date as "not set
-- yet"; nothing published can have one, since submission requires both.

ALTER TYPE "venue_status" ADD VALUE IF NOT EXISTS 'draft';
--> statement-breakpoint
ALTER TYPE "membership_status" ADD VALUE IF NOT EXISTS 'draft';
--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "starts_at" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "ends_at" DROP NOT NULL;
--> statement-breakpoint
-- A draft may also have no location yet: neither a venue nor a standalone
-- address. 0017's scope check allowed exactly one of the two; it now allows
-- neither as well, as long as nothing standalone is half-set. Submission for
-- review still requires one (events_service.eventMissing).
ALTER TABLE "events" DROP CONSTRAINT IF EXISTS "events_scope_chk";
--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_scope_chk" CHECK (
  (venue_id IS NOT NULL
     AND address_json IS NULL AND lat IS NULL AND lng IS NULL AND tz_name IS NULL)
  OR
  (venue_id IS NULL
     AND address_json IS NOT NULL AND tz_name IS NOT NULL)
  OR
  (venue_id IS NULL
     AND address_json IS NULL AND lat IS NULL AND lng IS NULL AND tz_name IS NULL)
);
