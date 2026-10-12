-- Auto-rollover for arena schedules: a partner saves the weekly plan they
-- built and the worker keeps the next 7 business days released from it, so a
-- day never goes unbookable because nobody remembered to extend the schedule.
ALTER TABLE "arenas" ADD COLUMN IF NOT EXISTS "auto_rollover_enabled" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "arenas" ADD COLUMN IF NOT EXISTS "rollover_plan" jsonb;--> statement-breakpoint
ALTER TABLE "arenas" ADD COLUMN IF NOT EXISTS "rollover_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "arenas" ADD COLUMN IF NOT EXISTS "rollover_last_run_at" timestamp with time zone;--> statement-breakpoint
-- The worker scans for enabled arenas every hour; keep that scan an index hit.
CREATE INDEX IF NOT EXISTS "arenas_auto_rollover_idx" ON "arenas" ("auto_rollover_enabled") WHERE "auto_rollover_enabled" = true;
