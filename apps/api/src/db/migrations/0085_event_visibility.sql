-- Private / invite-only events. `visibility` controls consumer discovery:
--   public      — normal discovery (default, existing behaviour)
--   unlisted    — hidden from all consumer listings; reachable by direct link
--   access_code — listed, but tiers/booking locked behind `access_code`
-- `access_code` is required (non-blank) for access_code events.

CREATE TYPE "public"."event_visibility" AS ENUM('public', 'unlisted', 'access_code');--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "visibility" "event_visibility" DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "access_code" text;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_access_code_chk" CHECK ("visibility" <> 'access_code' OR ("access_code" IS NOT NULL AND btrim("access_code") <> ''));
