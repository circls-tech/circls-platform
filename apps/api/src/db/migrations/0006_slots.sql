CREATE TYPE "public"."slot_status" AS ENUM('open', 'held', 'blocked', 'booked');--> statement-breakpoint
CREATE TABLE "slot_releases" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"arena_id" uuid NOT NULL,
	"start_date" timestamp with time zone NOT NULL,
	"end_date" timestamp with time zone NOT NULL,
	"quantization_min" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slots" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"arena_id" uuid NOT NULL,
	"time_range" "tstzrange" NOT NULL,
	"price_paise" bigint NOT NULL,
	"status" "slot_status" DEFAULT 'open' NOT NULL,
	"hold_expires_at" timestamp with time zone,
	"booking_id" uuid,
	"release_id" uuid,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "slot_releases" ADD CONSTRAINT "slot_releases_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_releases" ADD CONSTRAINT "slot_releases_arena_id_arenas_id_fk" FOREIGN KEY ("arena_id") REFERENCES "public"."arenas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slots" ADD CONSTRAINT "slots_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slots" ADD CONSTRAINT "slots_arena_id_arenas_id_fk" FOREIGN KEY ("arena_id") REFERENCES "public"."arenas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slots" ADD CONSTRAINT "slots_release_id_slot_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."slot_releases"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "slots" ADD CONSTRAINT "slots_no_overlap" EXCLUDE USING gist ("arena_id" WITH =, "time_range" WITH &&) WHERE (deleted_at IS NULL);