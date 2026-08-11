-- Billing knobs: per-tenant gateway-fee split, two-sided commission with
-- per-event overrides, and advance payouts.
--
-- Defaults preserve today's behaviour exactly: customer pays 100% of the
-- gateway fee, no consumer commission, no advances. NULL payment snapshots
-- mean "pre-feature row" and fall back to legacy semantics at read time
-- (see payout_service / refund_service), so no backfill is needed.

ALTER TABLE "tenants"
  ADD COLUMN "consumer_commission_bps" integer NOT NULL DEFAULT 0,
  ADD COLUMN "customer_fee_share_bps" integer NOT NULL DEFAULT 10000,
  ADD COLUMN "org_fee_share_bps" integer NOT NULL DEFAULT 0,
  ADD COLUMN "advance_payout_bps" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "tenants"
  ADD CONSTRAINT "tenants_billing_bps_chk" CHECK (
    consumer_commission_bps BETWEEN 0 AND 10000
    AND customer_fee_share_bps BETWEEN 0 AND 10000
    AND org_fee_share_bps BETWEEN 0 AND 10000
    AND customer_fee_share_bps + org_fee_share_bps <= 10000
    AND advance_payout_bps BETWEEN 0 AND 10000);
--> statement-breakpoint
ALTER TABLE "events"
  ADD COLUMN "partner_commission_bps" integer,
  ADD COLUMN "consumer_commission_bps" integer,
  ADD COLUMN "advance_payout_bps" integer;
--> statement-breakpoint
ALTER TABLE "events"
  ADD CONSTRAINT "events_billing_bps_chk" CHECK (
    (partner_commission_bps IS NULL OR partner_commission_bps BETWEEN 0 AND 10000)
    AND (consumer_commission_bps IS NULL OR consumer_commission_bps BETWEEN 0 AND 10000)
    AND (advance_payout_bps IS NULL OR advance_payout_bps BETWEEN 0 AND 10000));
--> statement-breakpoint
ALTER TABLE "payments"
  ADD COLUMN "consumer_commission_paise" bigint,
  ADD COLUMN "partner_commission_paise" bigint,
  ADD COLUMN "advance_paise" bigint,
  ADD COLUMN "advance_released_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX "payments_advance_released_idx"
  ON "payments" ("advance_released_at")
  WHERE "advance_released_at" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "payouts"
  ADD COLUMN "advances_paise" bigint NOT NULL DEFAULT 0,
  ADD COLUMN "advance_recouped_paise" bigint NOT NULL DEFAULT 0;
