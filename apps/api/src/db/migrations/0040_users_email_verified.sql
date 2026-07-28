ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email_verified" boolean NOT NULL DEFAULT false;
-- Backfill: treat every pre-existing email as verified. Until now the only
-- writers were require_auth (verified Firebase tokens only, C1 gate) and
-- invitation acceptance (possession of a token emailed to the address); the
-- consumer profile PATCH could also write one, but flipping those to false
-- retroactively would break row adoption for legitimate returning users.
UPDATE "users" SET "email_verified" = true WHERE "email" IS NOT NULL;
