ALTER TABLE "venues" ADD COLUMN "tags" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "arenas" ADD COLUMN "tags" text[] DEFAULT '{}'::text[] NOT NULL;