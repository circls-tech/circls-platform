-- Per-aspect listing auto-approval.
--
-- WHY: `auto_approve_listings` (migration 0079) was one switch for everything
-- an org submits. Platform admins want to trust an org with, say, its venues
-- and memberships while still reviewing its events, or to let later changes
-- to live events through without review while new listings still queue. The
-- one boolean becomes a jsonb blob with a key per aspect — `venues` (venues
-- and arenas), `events`, `memberships` and `changes` (event change requests,
-- live arena edits) — read like `email_prefs`: a missing key means off, so a
-- future aspect needs no migration.
--
-- Orgs that had the old switch on get every aspect on, so nothing they could
-- do without review starts queuing; everyone else gets the empty blob (off).
--
-- `auto_approve_listings` is deliberately NOT dropped here. The API that is
-- running when this applies (and any release rolled back to) still selects
-- it on every tenant read, so dropping it in the same release would break
-- those reads. The new code no longer reads or writes it; drop it in a later
-- migration, once no deployed API selects it.

ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "auto_approve" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
UPDATE "tenants"
SET "auto_approve" = '{"venues": true, "events": true, "memberships": true, "changes": true}'::jsonb
WHERE "auto_approve_listings" = true;
