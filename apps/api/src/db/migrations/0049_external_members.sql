-- Members a partner adds by hand, for someone who joined off-platform.
--
-- WHY: `user_memberships.user_id` was NOT NULL and FK'd to `users`, so every
-- member had to have a circls account. A partner who signed someone up at the
-- desk, over the phone, or on paper had nowhere to record them: the member was
-- missing from the buyers list and, more importantly, from the per-tier
-- capacity count, so a tier could be oversold by everyone who joined offline.
--
-- Bookings already solved this shape — nullable `customer_user_id` alongside
-- free-text `customer_name`/`customer_contact` — so this mirrors it rather than
-- inventing a second pattern. `external_name` / `external_contact` carry the
-- identity when there is no account behind the row.
--
-- The CHECK is the important half: a row must identify its member one way or
-- the other. Without it a NULL user_id and a NULL name would produce an
-- anonymous membership that no partner could act on and no consumer could claim.
--
-- Money is untouched on purpose. `payment_id` simply stays NULL for these rows,
-- and payouts are computed from `payments`, so a hand-added member can never
-- reach a settlement, commission or advance.
--
-- No backfill: every existing row has a user_id and passes the CHECK unchanged.

ALTER TABLE "user_memberships" ALTER COLUMN "user_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "user_memberships"
  ADD COLUMN "external_name" text,
  ADD COLUMN "external_contact" text;
--> statement-breakpoint
-- Who recorded the member, for the audit trail. NULL for consumer purchases,
-- which are made by the member themselves.
ALTER TABLE "user_memberships"
  ADD COLUMN "created_by_user_id" uuid REFERENCES "users"("id");
--> statement-breakpoint
ALTER TABLE "user_memberships"
  ADD CONSTRAINT "user_memberships_member_identity_chk" CHECK (
    "user_id" IS NOT NULL OR "external_name" IS NOT NULL);
