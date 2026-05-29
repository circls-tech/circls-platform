-- Subproject B (cont.): new venues / arenas / memberships are created
-- `pending_review` (the partner must be approved before going live). Events
-- keep their `draft` default — the partner's publish action moves them to
-- pending_review. Existing rows keep their current value (grandfathered as
-- already-approved), so nothing live disappears.
ALTER TABLE "venues" ALTER COLUMN "status" SET DEFAULT 'pending_review';
--> statement-breakpoint
ALTER TABLE "arenas" ALTER COLUMN "status" SET DEFAULT 'pending_review';
--> statement-breakpoint
ALTER TABLE "memberships" ALTER COLUMN "status" SET DEFAULT 'pending_review';
