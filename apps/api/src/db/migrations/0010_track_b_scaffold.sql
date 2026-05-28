-- Track B scaffold (Phases 11–17). One migration, many tables. Subagents
-- implementing each phase build on the shapes locked here; if a column needs
-- to change later, that's a separate migration owned by the relevant phase.

-- Phase 11 — Tenant KYC + bank columns, kyc_documents table.
ALTER TYPE "kyc_status" ADD VALUE IF NOT EXISTS 'submitted' BEFORE 'in_review';
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "pan_number" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "bank_account_number" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "bank_ifsc" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "bank_account_holder_name" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "kyc_submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "kyc_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "kyc_rejection_reason" text;--> statement-breakpoint
CREATE TABLE "kyc_documents" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"doc_type" text NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text,
	"size_bytes" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kyc_documents" ADD CONSTRAINT "kyc_documents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "kyc_documents_tenant_idx" ON "kyc_documents" ("tenant_id");

-- Phase 12 — payments + payouts ledger.
--> statement-breakpoint
CREATE TYPE "payment_provider" AS ENUM ('razorpay', 'stub', 'external');
--> statement-breakpoint
CREATE TYPE "payment_status" AS ENUM ('pending', 'authorized', 'captured', 'failed', 'refunded', 'partially_refunded');
--> statement-breakpoint
CREATE TYPE "payment_kind" AS ENUM ('charge', 'refund', 'adjustment');
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"booking_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" "payment_provider" NOT NULL,
	"provider_order_id" text,
	"provider_payment_id" text,
	"amount_paise" bigint NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"status" "payment_status" DEFAULT 'pending' NOT NULL,
	"kind" "payment_kind" NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"settlement_hold_until" timestamp with time zone,
	"settlement_released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "payments_booking_idx" ON "payments" ("booking_id");
--> statement-breakpoint
CREATE INDEX "payments_tenant_idx" ON "payments" ("tenant_id");
--> statement-breakpoint
-- Idempotency on the provider payment id (charges & refunds get separate ids).
CREATE UNIQUE INDEX "payments_provider_payment_uniq" ON "payments" ("provider", "provider_payment_id") WHERE "provider_payment_id" IS NOT NULL;
--> statement-breakpoint
-- Settlement-hold sweeper needs to find rows whose hold has expired.
CREATE INDEX "payments_settlement_hold_idx" ON "payments" ("settlement_hold_until") WHERE "settlement_released_at" IS NULL AND "settlement_hold_until" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE "payouts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" "payment_provider" NOT NULL,
	"provider_payout_id" text,
	"amount_paise" bigint NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"status" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reconciled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "payouts_tenant_idx" ON "payouts" ("tenant_id");

-- Phase 13 — notifications ledger.
--> statement-breakpoint
CREATE TYPE "notification_channel" AS ENUM ('sms', 'email', 'whatsapp');
--> statement-breakpoint
CREATE TYPE "notification_status" AS ENUM ('pending', 'sent', 'failed', 'skipped');
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid,
	"user_id" uuid,
	"channel" "notification_channel" NOT NULL,
	"recipient" text NOT NULL,
	"template_key" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "notification_status" DEFAULT 'pending' NOT NULL,
	"provider_message_id" text,
	"error" text,
	"scheduled_for" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- Dispatcher query: pending + scheduled-for-now-or-earlier.
CREATE INDEX "notifications_pending_idx" ON "notifications" ("scheduled_for") WHERE "status" = 'pending';

-- Phase 15 — events, event_arenas, memberships, user_memberships.
--> statement-breakpoint
CREATE TYPE "event_status" AS ENUM ('draft', 'published', 'cancelled');
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"venue_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"price_paise" bigint DEFAULT 0 NOT NULL,
	"capacity" integer,
	"status" "event_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "events_tenant_idx" ON "events" ("tenant_id");
--> statement-breakpoint
CREATE INDEX "events_venue_idx" ON "events" ("venue_id");
--> statement-breakpoint
CREATE TABLE "event_arenas" (
	"event_id" uuid NOT NULL,
	"arena_id" uuid NOT NULL,
	CONSTRAINT "event_arenas_pk" PRIMARY KEY ("event_id", "arena_id")
);
--> statement-breakpoint
ALTER TABLE "event_arenas" ADD CONSTRAINT "event_arenas_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "event_arenas" ADD CONSTRAINT "event_arenas_arena_id_arenas_id_fk" FOREIGN KEY ("arena_id") REFERENCES "public"."arenas"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE TYPE "membership_status" AS ENUM ('active', 'inactive');
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"venue_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"price_paise" bigint DEFAULT 0 NOT NULL,
	"duration_days" integer NOT NULL,
	"benefits" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "membership_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "memberships_tenant_idx" ON "memberships" ("tenant_id");
--> statement-breakpoint
CREATE TYPE "user_membership_status" AS ENUM ('active', 'expired', 'cancelled');
--> statement-breakpoint
CREATE TABLE "user_memberships" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"payment_id" uuid,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" "user_membership_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_memberships" ADD CONSTRAINT "user_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "user_memberships" ADD CONSTRAINT "user_memberships_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "user_memberships" ADD CONSTRAINT "user_memberships_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "user_memberships_user_idx" ON "user_memberships" ("user_id");

-- Phase 17 — api_keys + webhook_subscriptions + outbound_webhook_deliveries.
--> statement-breakpoint
CREATE TYPE "api_key_role" AS ENUM ('read', 'write', 'admin');
--> statement-breakpoint
CREATE TYPE "api_key_status" AS ENUM ('active', 'revoked');
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"role" "api_key_role" NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "api_key_status" DEFAULT 'active' NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "api_keys_prefix_idx" ON "api_keys" ("key_prefix");
--> statement-breakpoint
CREATE INDEX "api_keys_tenant_idx" ON "api_keys" ("tenant_id");
--> statement-breakpoint
CREATE TYPE "webhook_subscription_status" AS ENUM ('active', 'disabled');
--> statement-breakpoint
CREATE TABLE "webhook_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"url" text NOT NULL,
	"secret" text NOT NULL,
	"events" text[] NOT NULL,
	"status" "webhook_subscription_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "webhook_subscriptions" ADD CONSTRAINT "webhook_subscriptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "webhook_subscriptions_tenant_idx" ON "webhook_subscriptions" ("tenant_id");
--> statement-breakpoint
CREATE TYPE "webhook_delivery_status" AS ENUM ('pending', 'delivered', 'failed', 'expired');
--> statement-breakpoint
CREATE TABLE "outbound_webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"subscription_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "webhook_delivery_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "outbound_webhook_deliveries" ADD CONSTRAINT "outbound_webhook_deliveries_subscription_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."webhook_subscriptions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Delivery worker query: pending + due.
CREATE INDEX "outbound_webhook_deliveries_pending_idx" ON "outbound_webhook_deliveries" ("next_attempt_at") WHERE "status" = 'pending';
