CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint
CREATE TYPE "public"."arena_status" AS ENUM('active', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."booking_channel" AS ENUM('circls', 'aggregator', 'venue_site', 'walkin');--> statement-breakpoint
CREATE TYPE "public"."booking_item_type" AS ENUM('slot', 'event', 'membership');--> statement-breakpoint
CREATE TYPE "public"."booking_payment_method" AS ENUM('razorpay_route', 'external', 'free');--> statement-breakpoint
CREATE TYPE "public"."booking_status" AS ENUM('pending', 'confirmed', 'cancelled', 'completed', 'no_show');--> statement-breakpoint
CREATE TABLE "arenas" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"venue_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sport" text,
	"capacity" integer,
	"slot_duration_min" integer DEFAULT 60 NOT NULL,
	"status" "arena_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "weekly_schedule" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"arena_id" uuid NOT NULL,
	"day_of_week" integer NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"slot_duration_min" integer DEFAULT 60 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"venue_id" uuid,
	"item_type" "booking_item_type" NOT NULL,
	"slot_arena_id" uuid,
	"time_range" "tstzrange",
	"channel" "booking_channel" NOT NULL,
	"payment_method" "booking_payment_method" NOT NULL,
	"status" "booking_status" DEFAULT 'pending' NOT NULL,
	"item_data" jsonb,
	"price_paise" bigint,
	"customer_user_id" uuid,
	"customer_contact_json" jsonb,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "arenas" ADD CONSTRAINT "arenas_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_schedule" ADD CONSTRAINT "weekly_schedule_arena_id_arenas_id_fk" FOREIGN KEY ("arena_id") REFERENCES "public"."arenas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_slot_arena_id_arenas_id_fk" FOREIGN KEY ("slot_arena_id") REFERENCES "public"."arenas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_customer_user_id_users_id_fk" FOREIGN KEY ("customer_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Inventory invariant: forbid two non-cancelled SLOT bookings whose time_range
-- overlaps on the same arena. Needs btree_gist for the `=` on slot_arena_id.
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_no_overlap" EXCLUDE USING gist ("slot_arena_id" WITH =, "time_range" WITH &&) WHERE (status <> 'cancelled' AND item_type = 'slot');