-- Per-item payout lines: what each payout actually paid for, and whether that
-- particular line has been transferred.
--
-- Hand-written (drizzle-kit can't express the NULLS NOT DISTINCT unique index,
-- and the payouts.status widening is a data migration). PG15+ is required for
-- NULLS NOT DISTINCT; we're on 18.
--
-- `item_id` is nullable on purpose: an unattributable sale, and the synthetic
-- `advance` / `unattributed` lines, have no item behind them. Postgres treats
-- NULLs as distinct in a unique index by default, which would let the same
-- payout collect several `advance` rows — NULLS NOT DISTINCT closes that.
CREATE TABLE "payout_items" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"payout_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"item_type" text NOT NULL,
	"item_id" uuid,
	"currency" text NOT NULL DEFAULT 'INR',
	"gross_paise" bigint NOT NULL DEFAULT 0,
	"refunds_paise" bigint NOT NULL DEFAULT 0,
	"commission_paise" bigint NOT NULL DEFAULT 0,
	"amount_paise" bigint NOT NULL,
	"status" text NOT NULL DEFAULT 'pending',
	"paid_at" timestamp with time zone,
	"paid_reference" text,
	"paid_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "payout_items" ADD CONSTRAINT "payout_items_payout_id_fk"
	FOREIGN KEY ("payout_id") REFERENCES "payouts"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "payout_items" ADD CONSTRAINT "payout_items_tenant_id_fk"
	FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id");--> statement-breakpoint

ALTER TABLE "payout_items" ADD CONSTRAINT "payout_items_type_chk"
	CHECK ("item_type" IN ('slot','event','membership','advance','unattributed'));--> statement-breakpoint
ALTER TABLE "payout_items" ADD CONSTRAINT "payout_items_status_chk"
	CHECK ("status" IN ('pending','paid'));--> statement-breakpoint
-- A paid line must say when and against what reference; a pending one must not
-- claim either. Keeps a half-written execute from looking settled.
ALTER TABLE "payout_items" ADD CONSTRAINT "payout_items_paid_fields_chk"
	CHECK (
		("status" = 'paid'    AND "paid_at" IS NOT NULL AND "paid_reference" IS NOT NULL)
		OR
		("status" = 'pending' AND "paid_at" IS NULL     AND "paid_reference" IS NULL)
	);--> statement-breakpoint

CREATE UNIQUE INDEX "payout_items_payout_item_uniq"
	ON "payout_items" ("payout_id", "item_type", "item_id") NULLS NOT DISTINCT;--> statement-breakpoint
CREATE INDEX "payout_items_payout_idx" ON "payout_items" ("payout_id");--> statement-breakpoint
-- Drives "what does this org still have unpaid", the Earnings tab's per-row
-- Mark paid, and the paid-out predicate.
CREATE INDEX "payout_items_tenant_status_idx" ON "payout_items" ("tenant_id", "status");--> statement-breakpoint
CREATE INDEX "payout_items_item_idx" ON "payout_items" ("item_type", "item_id");--> statement-breakpoint

-- A payout's status is now a rollup of its lines: paying one line leaves the
-- payout partially paid. Existing rows keep their current value — a payout
-- with no lines (everything reconciled before this migration) stays whatever
-- it was, and is treated as a single indivisible line by the read models.
ALTER TABLE "payouts" DROP CONSTRAINT IF EXISTS "payouts_status_chk";--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_status_chk"
	CHECK ("status" IN ('pending','partially_paid','paid'));
