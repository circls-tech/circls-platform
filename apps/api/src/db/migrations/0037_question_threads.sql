-- Questions threads (epic #106 follow-on): consumers ask questions on events,
-- arenas and memberships. Each question is a thread (root message + chat-style
-- replies) with an immutable public/private visibility, an open → answered →
-- closed lifecycle, and per-message moderation (hidden_at). Idempotent +
-- additive, hand-authored in the 0026_support_concerns.sql style.
--
-- NOTE: authored as 0037 on branch worktree-questions-threads; renumber at
-- merge if another in-flight branch claims the slot first.
--
-- EDITED IN PLACE on the stacked branch worktree-support-threads (support →
-- private threads + resolver context; still unreleased): adds the 'general'
-- subject type and the origin/category/context_booking_id/flow_answers
-- columns. Because the drizzle migrator decides "already applied" purely by
-- the journal timestamp, the journal `when` for 0037 was bumped so DBs that
-- ran the pre-support version of this file re-run it and pick up the deltas —
-- every statement here is idempotent, so the re-run is safe. The migrator
-- wraps the whole batch in ONE transaction, so the upgrade path relies on:
--   (a) PG >= 12 allowing ALTER TYPE ... ADD VALUE inside a transaction, and
--   (b) the new CHECK constraints comparing subject_type via ::text — an
--       enum-literal 'general' would trip "unsafe use of new value" in the
--       same transaction that added the value.

DO $$ BEGIN
  CREATE TYPE "question_subject_type" AS ENUM ('event', 'arena', 'membership', 'general');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
-- Upgrade path for DBs whose question_subject_type predates 'general'.
ALTER TYPE "question_subject_type" ADD VALUE IF NOT EXISTS 'general';
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "question_visibility" AS ENUM ('public', 'private');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "question_status" AS ENUM ('open', 'answered', 'closed');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "question_author_kind" AS ENUM ('consumer', 'org', 'circls');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "question_threads" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subject_type" question_subject_type NOT NULL,
	"event_id" uuid,
	"arena_id" uuid,
	"membership_id" uuid,
	"visibility" question_visibility NOT NULL,
	"status" question_status DEFAULT 'open' NOT NULL,
	"author_user_id" uuid NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"message_count" integer DEFAULT 1 NOT NULL,
	-- Thread-level moderation: an archived thread disappears from every
	-- consumer surface (staff retain access). Mirrors the per-message
	-- hidden_at / hidden_by_* trio on question_messages.
	"archived_at" timestamp with time zone,
	"archived_by_user_id" uuid,
	-- Who archived the thread ('org' = partner, 'circls' = admin). Drives the
	-- unarchive hierarchy: the org can only undo its own archives.
	"archived_by_kind" text,
	-- Intake channel: 'forum' = organic ask on a listing; 'support' = the
	-- consumer Help-widget interview.
	"origin" text DEFAULT 'forum' NOT NULL,
	-- Support-interview triage category (same values as support_issues.category).
	"category" text,
	-- Booking pinned as resolver context by the support interview.
	"context_booking_id" uuid,
	-- Support-interview transcript ([{question, answer}, ...]), the
	-- support_issues.flow_answers shape.
	"flow_answers" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_threads_archived_by_kind_chk" CHECK (
	  "archived_by_kind" IS NULL OR "archived_by_kind" IN ('org', 'circls')
	)
	-- The subject/origin/category/general-privacy CHECKs are added post-hoc
	-- below so the fresh-create and upgrade (pre-existing table) paths share
	-- one definition.
);
--> statement-breakpoint
-- Upgrade path: DBs that created question_threads before the support columns.
ALTER TABLE "question_threads" ADD COLUMN IF NOT EXISTS "origin" text DEFAULT 'forum' NOT NULL;
--> statement-breakpoint
ALTER TABLE "question_threads" ADD COLUMN IF NOT EXISTS "category" text;
--> statement-breakpoint
ALTER TABLE "question_threads" ADD COLUMN IF NOT EXISTS "context_booking_id" uuid;
--> statement-breakpoint
ALTER TABLE "question_threads" ADD COLUMN IF NOT EXISTS "flow_answers" jsonb;
--> statement-breakpoint
-- Exactly one subject FK is set, matching subject_type; 'general' threads
-- (support questions with no surviving subject) carry none. DROP + ADD (not a
-- guarded ADD) so DBs holding the pre-'general' definition get the new one.
-- ::text comparisons keep the same-transaction enum-value restriction away.
ALTER TABLE "question_threads" DROP CONSTRAINT IF EXISTS "question_threads_subject_chk";
--> statement-breakpoint
ALTER TABLE "question_threads" ADD CONSTRAINT "question_threads_subject_chk" CHECK (
  ("subject_type"::text = 'event'      AND "event_id" IS NOT NULL AND "arena_id" IS NULL     AND "membership_id" IS NULL) OR
  ("subject_type"::text = 'arena'      AND "arena_id" IS NOT NULL AND "event_id" IS NULL     AND "membership_id" IS NULL) OR
  ("subject_type"::text = 'membership' AND "membership_id" IS NOT NULL AND "event_id" IS NULL AND "arena_id" IS NULL) OR
  ("subject_type"::text = 'general'    AND "event_id" IS NULL AND "arena_id" IS NULL AND "membership_id" IS NULL)
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "question_threads" ADD CONSTRAINT "question_threads_origin_chk" CHECK (
    "origin" IN ('forum', 'support')
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "question_threads" ADD CONSTRAINT "question_threads_category_chk" CHECK (
    "category" IS NULL OR "category" IN (
      'booking_issue', 'refund_request', 'reschedule', 'venue_question', 'payment', 'other'
    )
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
-- 'general' threads are visible to asker + Circls only — never public.
DO $$ BEGIN
  ALTER TABLE "question_threads" ADD CONSTRAINT "question_threads_general_private_chk" CHECK (
    "subject_type"::text != 'general' OR "visibility" = 'private'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "question_threads" ADD CONSTRAINT "question_threads_context_booking_id_bookings_id_fk"
    FOREIGN KEY ("context_booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "question_threads" ADD CONSTRAINT "question_threads_tenant_id_tenants_id_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "question_threads" ADD CONSTRAINT "question_threads_event_id_events_id_fk"
    FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "question_threads" ADD CONSTRAINT "question_threads_arena_id_arenas_id_fk"
    FOREIGN KEY ("arena_id") REFERENCES "public"."arenas"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "question_threads" ADD CONSTRAINT "question_threads_membership_id_memberships_id_fk"
    FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "question_threads" ADD CONSTRAINT "question_threads_author_user_id_users_id_fk"
    FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "question_threads" ADD CONSTRAINT "question_threads_archived_by_user_id_users_id_fk"
    FOREIGN KEY ("archived_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
-- Org inbox: status tab + newest-activity sort within a tenant.
CREATE INDEX IF NOT EXISTS "question_threads_tenant_status_activity_idx"
  ON "question_threads" ("tenant_id", "status", "last_message_at" DESC);
--> statement-breakpoint
-- Public/consumer listings per subject (partial per subject column).
CREATE INDEX IF NOT EXISTS "question_threads_event_idx"
  ON "question_threads" ("event_id", "visibility", "last_message_at" DESC)
  WHERE "event_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "question_threads_arena_idx"
  ON "question_threads" ("arena_id", "visibility", "last_message_at" DESC)
  WHERE "arena_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "question_threads_membership_idx"
  ON "question_threads" ("membership_id", "visibility", "last_message_at" DESC)
  WHERE "membership_id" IS NOT NULL;
--> statement-breakpoint
-- "My questions" listing + the per-user thread-creation rate-limit count.
CREATE INDEX IF NOT EXISTS "question_threads_author_activity_idx"
  ON "question_threads" ("author_user_id", "last_message_at" DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "question_messages" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"thread_id" uuid NOT NULL,
	"author_user_id" uuid NOT NULL,
	"author_kind" question_author_kind NOT NULL,
	"body" text NOT NULL,
	"hidden_at" timestamp with time zone,
	"hidden_by_user_id" uuid,
	-- Who hid the message ('org' = partner moderation, 'circls' = admin).
	-- Drives the unhide hierarchy: the org can only undo its own hides.
	"hidden_by_kind" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_messages_hidden_by_kind_chk" CHECK (
	  "hidden_by_kind" IS NULL OR "hidden_by_kind" IN ('org', 'circls')
	)
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "question_messages" ADD CONSTRAINT "question_messages_thread_id_question_threads_id_fk"
    FOREIGN KEY ("thread_id") REFERENCES "public"."question_threads"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "question_messages" ADD CONSTRAINT "question_messages_author_user_id_users_id_fk"
    FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "question_messages" ADD CONSTRAINT "question_messages_hidden_by_user_id_users_id_fk"
    FOREIGN KEY ("hidden_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
-- Transcript reads (asc) + root-message resolution (earliest row of a thread).
CREATE INDEX IF NOT EXISTS "question_messages_thread_created_idx"
  ON "question_messages" ("thread_id", "created_at" ASC, "id" ASC);
--> statement-breakpoint
-- Per-user message rate-limit count (trailing 24h).
CREATE INDEX IF NOT EXISTS "question_messages_author_created_idx"
  ON "question_messages" ("author_user_id", "created_at" DESC);
