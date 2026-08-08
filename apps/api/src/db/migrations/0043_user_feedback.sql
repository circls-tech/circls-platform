-- Post-login consumer feedback: "how was the event" ratings for past
-- registrations + a one-off event-type preference poll answer, both snapshotting
-- the user's phone number (phone_e164) at submission time. Idempotent +
-- additive, hand-authored in the 0037_question_threads.sql style.
--
-- NOTE: authored as 0043 on branch claude/user-feedback; renumber at merge if
-- another in-flight branch claims the slot first.

DO $$ BEGIN
  CREATE TYPE "user_feedback_kind" AS ENUM ('event_feedback', 'event_type_preference');
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
	"event_id" uuid,
	"booking_id" uuid,
	"rating" integer,
	"comment" text,
	"question_key" text,
	"question" text,
	"answer" text,
	"source" text DEFAULT 'consumer' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- Shape per kind: event feedback carries event + 1–5 rating; the preference
	-- poll carries the served question snapshot + chosen answer. ::text
	-- comparisons keep the same-transaction enum-value restriction away.
	CONSTRAINT "user_feedback_shape_chk" CHECK (
	  ("kind"::text = 'event_feedback' AND "event_id" IS NOT NULL
	    AND "rating" IS NOT NULL AND "rating" BETWEEN 1 AND 5
	    AND "question_key" IS NULL AND "question" IS NULL AND "answer" IS NULL) OR
	  ("kind"::text = 'event_type_preference' AND "event_id" IS NULL AND "booking_id" IS NULL
	    AND "rating" IS NULL AND "comment" IS NULL
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
-- One event review per (user, event); the friendly Conflict lives app-side.
CREATE UNIQUE INDEX IF NOT EXISTS "user_feedback_event_uq"
  ON "user_feedback" ("user_id", "event_id")
  WHERE "kind" = 'event_feedback';
--> statement-breakpoint
-- One preference-poll answer per user.
CREATE UNIQUE INDEX IF NOT EXISTS "user_feedback_pref_uq"
  ON "user_feedback" ("user_id")
  WHERE "kind" = 'event_type_preference';
--> statement-breakpoint
-- Prompt eligibility check ("has this user reviewed this event / answered the
-- poll yet") + phone-keyed exports.
CREATE INDEX IF NOT EXISTS "user_feedback_user_kind_idx"
  ON "user_feedback" ("user_id", "kind", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_feedback_phone_idx"
  ON "user_feedback" ("phone_e164")
  WHERE "phone_e164" IS NOT NULL;
