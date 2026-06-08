CREATE TYPE "public"."coupon_owner_type" AS ENUM('platform', 'tenant');--> statement-breakpoint
CREATE TYPE "public"."coupon_scope_type" AS ENUM('org', 'venue', 'event', 'arena', 'membership');--> statement-breakpoint
CREATE TYPE "public"."coupon_discount_type" AS ENUM('percent', 'fixed');--> statement-breakpoint
CREATE TYPE "public"."coupon_visibility" AS ENUM('public', 'private');--> statement-breakpoint
CREATE TYPE "public"."coupon_status" AS ENUM('active', 'paused', 'expired');--> statement-breakpoint
CREATE TYPE "public"."coupon_funder" AS ENUM('org', 'platform');--> statement-breakpoint
CREATE TABLE "coupons" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"owner_type" "coupon_owner_type" NOT NULL,
	"tenant_id" uuid,
	"code" text NOT NULL,
	"description" text,
	"scope_type" "coupon_scope_type" NOT NULL,
	"scope_id" uuid,
	"discount_type" "coupon_discount_type" NOT NULL,
	"discount_value" bigint NOT NULL,
	"max_discount_paise" bigint,
	"min_order_paise" bigint,
	"visibility" "coupon_visibility" DEFAULT 'private' NOT NULL,
	"valid_from" timestamp with time zone,
	"valid_until" timestamp with time zone,
	"max_redemptions" integer,
	"per_user_limit" integer,
	"redeemed_count" integer DEFAULT 0 NOT NULL,
	"status" "coupon_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coupon_redemptions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"coupon_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"user_id" uuid,
	"tenant_id" uuid NOT NULL,
	"base_paise" bigint NOT NULL,
	"discount_paise" bigint NOT NULL,
	"funder" "coupon_funder" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_coupon_id_coupons_id_fk" FOREIGN KEY ("coupon_id") REFERENCES "public"."coupons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "coupons_platform_code_uq" ON "coupons" ("code") WHERE "owner_type" = 'platform';--> statement-breakpoint
CREATE UNIQUE INDEX "coupons_tenant_code_uq" ON "coupons" ("tenant_id","code") WHERE "owner_type" = 'tenant';--> statement-breakpoint
CREATE INDEX "coupons_tenant_idx" ON "coupons" ("tenant_id");--> statement-breakpoint
CREATE INDEX "coupons_owner_idx" ON "coupons" ("owner_type");--> statement-breakpoint
CREATE INDEX "coupons_scope_idx" ON "coupons" ("scope_type","scope_id");--> statement-breakpoint
CREATE UNIQUE INDEX "coupon_redemptions_coupon_booking_uq" ON "coupon_redemptions" ("coupon_id","booking_id");--> statement-breakpoint
CREATE INDEX "coupon_redemptions_coupon_user_idx" ON "coupon_redemptions" ("coupon_id","user_id");--> statement-breakpoint
CREATE INDEX "coupon_redemptions_tenant_funder_idx" ON "coupon_redemptions" ("tenant_id","funder","created_at");--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "coupon_id" uuid;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "discount_paise" bigint DEFAULT 0;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "base_paise" bigint;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_coupon_id_coupons_id_fk" FOREIGN KEY ("coupon_id") REFERENCES "public"."coupons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "settle_base_paise" bigint;
