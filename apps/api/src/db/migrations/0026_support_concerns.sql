-- Consumer Help concerns (epic #106): extend the existing partner support_issues
-- table with a channel discriminator, triage category, optional booking link, and
-- the MCQ flow transcript. Idempotent + additive; the existing partner submit and
-- admin list/patch flows are unaffected.
--
-- NOTE: numbered 0040 to avoid colliding with another in-flight branch that is
-- also adding migrations from 0026; the number is to be reconciled at merge.

DO $$ BEGIN
  CREATE TYPE "support_issue_source" AS ENUM('partner_help', 'consumer_chatbot');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "support_issue_category" AS ENUM('booking_issue', 'refund_request', 'reschedule', 'venue_question', 'payment', 'other');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "support_issues"
  ADD COLUMN IF NOT EXISTS "source" "support_issue_source" NOT NULL DEFAULT 'partner_help';

ALTER TABLE "support_issues"
  ADD COLUMN IF NOT EXISTS "category" "support_issue_category";

ALTER TABLE "support_issues"
  ADD COLUMN IF NOT EXISTS "booking_id" uuid REFERENCES "bookings"("id");

ALTER TABLE "support_issues"
  ADD COLUMN IF NOT EXISTS "flow_answers" jsonb;

-- Backfill: every pre-existing row is a partner Help Centre submission. The
-- column default already covers this for rows present at ADD COLUMN time; this
-- statement is belt-and-braces and a no-op on a fresh table.
UPDATE "support_issues" SET "source" = 'partner_help' WHERE "source" IS NULL;
