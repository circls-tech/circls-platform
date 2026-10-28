-- Consumer + partner feedback (builds on PR #171's post-login prompts):
--   * user_feedback: a 1–10 rating + optional note on something a consumer
--     booked — an event once it ends, a venue visit (slot booking) and a
--     membership a day after check-in — plus PR #171's one-off event-type poll.
--   * site_feedback: the website survey, once per consumer and once per partner
--     organisation.
--   * feedback_dismissals: "Not now" per person and prompt, kept server-side so
--     the weekly website nudge follows people across devices.
-- Every answer snapshots the person's phone (and email) at submission time.
-- Idempotent + additive, hand-authored in the 0037_question_threads.sql style.

DO $$ BEGIN
  CREATE TYPE "user_feedback_kind" AS ENUM (
    'event_feedback', 'venue_feedback', 'membership_feedback', 'event_type_preference'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_feedback" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	-- E.164 snapshot of users.phone_e164 at submission time; users.id stays the
	-- canonical FK, the phone is the stable human key requested for exports.
	"phone_e164" text,
	"kind" user_feedback_kind NOT NULL,
	-- The org whose listing was rated (null for the poll), for admin filters.
	"tenant_id" uuid,
	"event_id" uuid,
	-- The registration or court booking the rating is about.
	"booking_id" uuid,
	"venue_id" uuid,
	"membership_id" uuid,
	"user_membership_id" uuid,
	"rating" integer,
	"comment" text,
	"question_key" text,
	"question" text,
	"answer" text,
	"source" text DEFAULT 'consumer' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- Shape per kind: a rating carries its subject + a 1–10 score; the poll
	-- carries the served question snapshot + chosen answer, and in `comment`
	-- what they typed for "Other". ::text comparisons keep the
	-- same-transaction enum-value restriction away.
	CONSTRAINT "user_feedback_shape_chk" CHECK (
	  ("kind"::text IN ('event_feedback', 'venue_feedback', 'membership_feedback')
	    AND "rating" IS NOT NULL AND "rating" BETWEEN 1 AND 10
	    AND "question_key" IS NULL AND "question" IS NULL AND "answer" IS NULL
	    AND ("kind"::text <> 'event_feedback' OR "event_id" IS NOT NULL)
	    AND ("kind"::text <> 'venue_feedback' OR ("booking_id" IS NOT NULL AND "venue_id" IS NOT NULL))
	    AND ("kind"::text <> 'membership_feedback'
	      OR ("membership_id" IS NOT NULL AND "user_membership_id" IS NOT NULL))) OR
	  ("kind"::text = 'event_type_preference' AND "event_id" IS NULL AND "booking_id" IS NULL
	    AND "venue_id" IS NULL AND "membership_id" IS NULL AND "user_membership_id" IS NULL
	    AND "rating" IS NULL
	    AND "question_key" IS NOT NULL AND "question" IS NOT NULL AND "answer" IS NOT NULL)
	)
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "user_feedback" ADD CONSTRAINT "user_feedback_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "user_feedback" ADD CONSTRAINT "user_feedback_tenant_id_tenants_id_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "user_feedback" ADD CONSTRAINT "user_feedback_event_id_events_id_fk"
    FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "user_feedback" ADD CONSTRAINT "user_feedback_booking_id_bookings_id_fk"
    FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "user_feedback" ADD CONSTRAINT "user_feedback_venue_id_venues_id_fk"
    FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "user_feedback" ADD CONSTRAINT "user_feedback_membership_id_memberships_id_fk"
    FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "user_feedback" ADD CONSTRAINT "user_feedback_user_membership_id_user_memberships_id_fk"
    FOREIGN KEY ("user_membership_id") REFERENCES "public"."user_memberships"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
-- One rating per event, per court booking and per membership purchase; one
-- poll answer per user. The friendly Conflict lives app-side.
CREATE UNIQUE INDEX IF NOT EXISTS "user_feedback_event_uq"
  ON "user_feedback" ("user_id", "event_id")
  WHERE "kind" = 'event_feedback';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_feedback_venue_uq"
  ON "user_feedback" ("user_id", "booking_id")
  WHERE "kind" = 'venue_feedback';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_feedback_membership_uq"
  ON "user_feedback" ("user_id", "user_membership_id")
  WHERE "kind" = 'membership_feedback';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_feedback_pref_uq"
  ON "user_feedback" ("user_id")
  WHERE "kind" = 'event_type_preference';
--> statement-breakpoint
-- Admin list (newest first, by kind) + phone-keyed exports.
CREATE INDEX IF NOT EXISTS "user_feedback_kind_created_idx"
  ON "user_feedback" ("kind", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_feedback_phone_idx"
  ON "user_feedback" ("phone_e164")
  WHERE "phone_e164" IS NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "site_feedback_audience" AS ENUM ('consumer', 'partner');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "site_feedback" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"audience" site_feedback_audience NOT NULL,
	-- Who answered; for a partner, on behalf of tenant_id.
	"user_id" uuid NOT NULL,
	"tenant_id" uuid,
	"phone_e164" text,
	"email" text,
	-- Overall ease of the website, 1–10.
	"overall_rating" integer NOT NULL,
	-- Consumer questions: finding things to do, booking and paying. Null =
	-- "Haven't tried yet".
	"discovery_rating" integer,
	"booking_rating" integer,
	-- Partner questions: how easy creating each listing type was. Null =
	-- "Haven't tried yet".
	"event_creation_rating" integer,
	"venue_creation_rating" integer,
	"membership_creation_rating" integer,
	"challenges" text,
	"comments" text,
	"source" text DEFAULT 'consumer' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_feedback_ratings_chk" CHECK (
	  "overall_rating" BETWEEN 1 AND 10
	  AND ("discovery_rating" IS NULL OR "discovery_rating" BETWEEN 1 AND 10)
	  AND ("booking_rating" IS NULL OR "booking_rating" BETWEEN 1 AND 10)
	  AND ("event_creation_rating" IS NULL OR "event_creation_rating" BETWEEN 1 AND 10)
	  AND ("venue_creation_rating" IS NULL OR "venue_creation_rating" BETWEEN 1 AND 10)
	  AND ("membership_creation_rating" IS NULL OR "membership_creation_rating" BETWEEN 1 AND 10)
	),
	CONSTRAINT "site_feedback_shape_chk" CHECK (
	  ("audience"::text = 'consumer' AND "tenant_id" IS NULL
	    AND "event_creation_rating" IS NULL AND "venue_creation_rating" IS NULL
	    AND "membership_creation_rating" IS NULL) OR
	  ("audience"::text = 'partner' AND "tenant_id" IS NOT NULL
	    AND "discovery_rating" IS NULL AND "booking_rating" IS NULL)
	)
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "site_feedback" ADD CONSTRAINT "site_feedback_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "site_feedback" ADD CONSTRAINT "site_feedback_tenant_id_tenants_id_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
-- Once per consumer; once per partner organisation, whoever on the team answers.
CREATE UNIQUE INDEX IF NOT EXISTS "site_feedback_consumer_uq"
  ON "site_feedback" ("user_id")
  WHERE "audience" = 'consumer';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "site_feedback_partner_uq"
  ON "site_feedback" ("tenant_id")
  WHERE "audience" = 'partner';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "site_feedback_audience_created_idx"
  ON "site_feedback" ("audience", "created_at" DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "feedback_dismissals" (
	"user_id" uuid NOT NULL,
	-- Which prompt: 'event:<id>', 'venue:<bookingId>', 'membership:<id>',
	-- 'poll', 'site' or 'partner:<tenantId>'.
	"prompt_key" text NOT NULL,
	"dismissed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"times" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "feedback_dismissals_pk" PRIMARY KEY ("user_id", "prompt_key")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "feedback_dismissals" ADD CONSTRAINT "feedback_dismissals_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
