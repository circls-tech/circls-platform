ALTER TABLE "arenas" ADD COLUMN "business_day_start_min" integer DEFAULT 180 NOT NULL;--> statement-breakpoint
ALTER TABLE "arenas" ADD COLUMN "schedule_template" jsonb;
