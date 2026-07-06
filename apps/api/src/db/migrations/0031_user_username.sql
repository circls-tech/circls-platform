-- Unique public username for consumers. Nullable: existing users pick one
-- later from their profile page. Stored lowercase (normalised in the service);
-- the unique constraint makes it a hard guarantee that no two users share one.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "username" text;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "users" ADD CONSTRAINT "users_username_unique" UNIQUE("username");
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
END $$;
