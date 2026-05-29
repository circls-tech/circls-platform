-- Circls-as-merchant retarget: drop the Phase 11 KYC / Linked-Account stack,
-- add per-tenant commission, and extend payouts for the weekly ops workflow.

-- 1. Drop KYC document storage (FKs tenants).
DROP TABLE IF EXISTS "kyc_documents";
--> statement-breakpoint
-- 2. Drop the KYC / Linked-Account / banking footprint from tenants.
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "kyc_status";
--> statement-breakpoint
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "kyc_submitted_at";
--> statement-breakpoint
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "kyc_verified_at";
--> statement-breakpoint
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "kyc_rejection_reason";
--> statement-breakpoint
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "razorpay_linked_account_id";
--> statement-breakpoint
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "legal_entity_name";
--> statement-breakpoint
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "gstin";
--> statement-breakpoint
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "pan_number";
--> statement-breakpoint
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "bank_account_number";
--> statement-breakpoint
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "bank_ifsc";
--> statement-breakpoint
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "bank_account_holder_name";
--> statement-breakpoint
DROP TYPE IF EXISTS "kyc_status";
--> statement-breakpoint
-- 3. Per-tenant commission, in basis points (100 bps = 1%).
ALTER TABLE "tenants" ADD COLUMN "commission_bps" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- 4. Extend payouts for the weekly Circls-as-merchant workflow.
ALTER TABLE "payouts" ADD COLUMN "period_start" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "period_end" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "gross_paise" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "refunds_paise" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "commission_paise" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "paid_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "paid_reference" text;
--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "paid_by_user_id" uuid;
--> statement-breakpoint
ALTER TABLE "payouts" ALTER COLUMN "status" SET DEFAULT 'pending';
--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_paid_by_user_id_users_id_fk" FOREIGN KEY ("paid_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "payouts_tenant_period_uniq" ON "payouts" ("tenant_id","period_start","period_end");
