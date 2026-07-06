-- QR tickets: partners can enable QR entry tickets on events, arenas and
-- memberships (qr_ticket_config JSONB, null = disabled). When a purchase is
-- finalised, qr_tickets rows are minted per the config (validity window frozen
-- from the item's own start/end plus configured offsets; single- vs multi-use
-- and scan caps copied onto the row). Scanning/validation is an online lookup
-- by the unique opaque `code`.

ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "qr_ticket_config" jsonb;
--> statement-breakpoint
ALTER TABLE "arenas" ADD COLUMN IF NOT EXISTS "qr_ticket_config" jsonb;
--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN IF NOT EXISTS "qr_ticket_config" jsonb;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "qr_ticket_status" AS ENUM ('active', 'used', 'revoked');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "qr_tickets" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"booking_id" uuid,
	"user_membership_id" uuid,
	"item_type" booking_item_type NOT NULL,
	"label" text,
	"code" text NOT NULL,
	"valid_from" timestamp with time zone,
	"valid_until" timestamp with time zone,
	"multi_use" boolean DEFAULT false NOT NULL,
	"max_scans" integer,
	"scan_count" integer DEFAULT 0 NOT NULL,
	"first_scanned_at" timestamp with time zone,
	"last_scanned_at" timestamp with time zone,
	"status" qr_ticket_status DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qr_tickets_code_unique" UNIQUE("code"),
	-- Every ticket admits something: a booking, a user membership, or both.
	CONSTRAINT "qr_tickets_subject_chk" CHECK ("booking_id" IS NOT NULL OR "user_membership_id" IS NOT NULL)
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "qr_tickets" ADD CONSTRAINT "qr_tickets_tenant_id_tenants_id_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "qr_tickets" ADD CONSTRAINT "qr_tickets_booking_id_bookings_id_fk"
    FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "qr_tickets" ADD CONSTRAINT "qr_tickets_user_membership_id_user_memberships_id_fk"
    FOREIGN KEY ("user_membership_id") REFERENCES "public"."user_memberships"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "qr_tickets_booking_id_idx" ON "qr_tickets" ("booking_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "qr_tickets_user_membership_id_idx" ON "qr_tickets" ("user_membership_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "qr_tickets_tenant_id_idx" ON "qr_tickets" ("tenant_id");
