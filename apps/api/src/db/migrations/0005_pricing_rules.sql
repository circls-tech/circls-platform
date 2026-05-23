CREATE TABLE "pricing_rules" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"arena_id" uuid NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"day_of_week" integer,
	"start_time_min" integer,
	"start_time_max" integer,
	"channel" "booking_channel",
	"member_only" boolean DEFAULT false NOT NULL,
	"price_paise" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pricing_rules" ADD CONSTRAINT "pricing_rules_arena_id_arenas_id_fk" FOREIGN KEY ("arena_id") REFERENCES "public"."arenas"("id") ON DELETE no action ON UPDATE no action;