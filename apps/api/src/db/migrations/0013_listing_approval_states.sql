-- Subproject B: listing approval. Add pending_review / rejected to the four
-- listing status enums. The create-default is NOT changed at the DB level
-- (Postgres forbids using a freshly-added enum value as a column default in the
-- same transaction, and Drizzle runs all pending migrations in one tx); instead
-- the create services set status='pending_review' explicitly. DB defaults stay
-- 'active'/'draft' so existing rows stay grandfathered.
ALTER TYPE "venue_status" ADD VALUE IF NOT EXISTS 'pending_review';
--> statement-breakpoint
ALTER TYPE "venue_status" ADD VALUE IF NOT EXISTS 'rejected';
--> statement-breakpoint
ALTER TYPE "arena_status" ADD VALUE IF NOT EXISTS 'pending_review';
--> statement-breakpoint
ALTER TYPE "arena_status" ADD VALUE IF NOT EXISTS 'rejected';
--> statement-breakpoint
ALTER TYPE "membership_status" ADD VALUE IF NOT EXISTS 'pending_review';
--> statement-breakpoint
ALTER TYPE "membership_status" ADD VALUE IF NOT EXISTS 'rejected';
--> statement-breakpoint
ALTER TYPE "event_status" ADD VALUE IF NOT EXISTS 'pending_review';
--> statement-breakpoint
ALTER TYPE "event_status" ADD VALUE IF NOT EXISTS 'rejected';
