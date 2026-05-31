ALTER TABLE "users" ADD COLUMN "interests" text[] DEFAULT '{}'::text[] NOT NULL;
