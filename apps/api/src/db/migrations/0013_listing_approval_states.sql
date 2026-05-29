-- Subproject B: listing approval. Add pending_review / rejected to the four
-- listing status enums. (Defaults are flipped in 0013b, a separate migration,
-- because Postgres forbids using a freshly-added enum value as a column default
-- in the same transaction.)
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
