-- Server-driven UI (SDUI): versioned screen layouts the mobile apps fetch
-- and render, so a layout change ships without an app-store review.
-- One row per (app, key, version): at most one 'draft' per screen (the next
-- version number), any number of 'published' (the highest wins, older ones
-- are tidied to 'archived'). Feature flags and the update notice live in
-- platform_settings (keys sdui.flags.<app>, sdui.update.<app>).
-- Idempotent + additive, hand-authored in the 0077_feedback.sql style.

CREATE TABLE IF NOT EXISTS "screen_layouts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	-- 'consumer' | 'partners'
	"app" text NOT NULL,
	-- Screen key, e.g. 'explore', 'home', 'more_menu', 'event_detail'.
	"key" text NOT NULL,
	-- Monotonic per (app, key); the draft row holds the next number.
	"version" integer NOT NULL,
	-- 'draft' | 'published' | 'archived'
	"status" text NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	-- Lowest app build per platform that may render it, e.g. {"ios":12,"android":12}.
	"min_build" jsonb DEFAULT '{}'::jsonb NOT NULL,
	-- The full screen document (lib/sdui/schema.ts).
	"body" jsonb NOT NULL,
	"note" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	CONSTRAINT "screen_layouts_app_chk" CHECK ("app" IN ('consumer', 'partners')),
	CONSTRAINT "screen_layouts_status_chk" CHECK ("status" IN ('draft', 'published', 'archived')),
	CONSTRAINT "screen_layouts_app_key_version_uq" UNIQUE ("app", "key", "version")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "screen_layouts" ADD CONSTRAINT "screen_layouts_created_by_user_id_users_id_fk"
    FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "screen_layouts_one_draft_uq" ON "screen_layouts" ("app", "key")
  WHERE "status" = 'draft';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "screen_layouts_app_key_status_idx" ON "screen_layouts" ("app", "key", "status");
