ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email_verified" boolean NOT NULL DEFAULT false;
-- Backfill by provenance. Historically there were exactly two email writers:
--   1. Invitation acceptance — possession of a token emailed to the address
--      proves the inbox. Those rows belong to email-credential Firebase
--      accounts and carry NO phone (phones only ever arrive via phone-OTP
--      logins, which are separate Firebase accounts). => verified.
--   2. The consumer profile PATCH — self-reported, unproven, and only
--      reachable by phone-signup consumers, so those rows DO carry a phone.
--      => stays unverified; the login backfill promotes it if the owner ever
--      proves the address, and a verified claimant on another account can
--      evict it (see user_service.ts).
-- (require_auth's C1 gate has always dropped unverified token emails, and no
-- portal ever sent verification mail, so verified-token writes are ~nonexistent.)
UPDATE "users" SET "email_verified" = true
WHERE "email" IS NOT NULL AND "phone_e164" IS NULL;
-- Uniqueness becomes verified-only: a proven address is an identity key and
-- may exist on exactly one row; unverified copies are contact info and may
-- coexist (a consumer keeps their receipt email even though the partner
-- credential owns the address — no eviction needed).
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_email_unique";
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_verified_unique"
  ON "users" ("email") WHERE "email_verified" = true;
