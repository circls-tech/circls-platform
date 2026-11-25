-- What a hand-added member paid at the desk, how they paid, and a note.
--
-- WHY: a member the partner records by hand (0049) took a seat on the tier but
-- left no trace of the money: the desk had nowhere to write down that Deepa
-- paid ₹1,500 by UPI, or that Kabir got the tier at a discount because he
-- renewed early. Partners kept that in a notebook beside the counter, so the
-- members list could never answer "what did they pay?" and reconciling the
-- till against circls meant two sources.
--
-- The three columns are the desk's record, nothing more. `desk_paid_paise` is
-- minor units of the plan's currency and defaults to the tier's price at the
-- time of adding, so the common case needs no typing; a custom amount
-- overrides it. `desk_payment_method` is how the money changed hands. `note`
-- is free text for whatever else the desk wants to remember.
--
-- Money invariants are unchanged on purpose: `payment_id` stays NULL for these
-- rows and payouts are computed from `payments`, so nothing recorded here can
-- reach a settlement, commission or advance. Consumer purchases leave all
-- three NULL — their money is on `payments`.
--
-- No backfill: members added before this simply have nothing recorded.

DO $$ BEGIN
  CREATE TYPE "desk_payment_method" AS ENUM (
    'cash', 'upi', 'card', 'bank_transfer', 'cheque', 'other');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
ALTER TABLE "user_memberships"
  ADD COLUMN IF NOT EXISTS "desk_paid_paise" bigint,
  ADD COLUMN IF NOT EXISTS "desk_payment_method" "desk_payment_method",
  ADD COLUMN IF NOT EXISTS "note" text;
