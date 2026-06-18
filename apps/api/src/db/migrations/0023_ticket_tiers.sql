-- Ticket tiers: per-event, per-tier price + capacity. A booking stays one row;
-- its tier breakdown lives in event_booking_tickets (also the source of per-tier
-- sold counts). Existing events are backfilled into one "General Admission" tier
-- and existing non-cancelled event bookings get a matching line so per-tier sold
-- counts stay correct. events.price_paise/capacity become legacy; price_paise is
-- kept in sync (min tier price) by the app for list display.

CREATE TABLE "event_ticket_tiers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"event_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"price_paise" bigint DEFAULT 0 NOT NULL,
	"capacity" integer,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "event_booking_tickets" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"booking_id" uuid NOT NULL,
	"tier_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price_paise" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_booking_tickets_qty_chk" CHECK ("quantity" > 0)
);
--> statement-breakpoint
ALTER TABLE "event_ticket_tiers" ADD CONSTRAINT "event_ticket_tiers_event_id_events_id_fk"
	FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "event_ticket_tiers" ADD CONSTRAINT "event_ticket_tiers_tenant_id_tenants_id_fk"
	FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "event_booking_tickets" ADD CONSTRAINT "event_booking_tickets_booking_id_bookings_id_fk"
	FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "event_booking_tickets" ADD CONSTRAINT "event_booking_tickets_tier_id_event_ticket_tiers_id_fk"
	FOREIGN KEY ("tier_id") REFERENCES "public"."event_ticket_tiers"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "event_ticket_tiers_event_id_idx" ON "event_ticket_tiers" ("event_id");
--> statement-breakpoint
CREATE INDEX "event_booking_tickets_tier_id_idx" ON "event_booking_tickets" ("tier_id");
--> statement-breakpoint
CREATE INDEX "event_booking_tickets_booking_id_idx" ON "event_booking_tickets" ("booking_id");
--> statement-breakpoint
-- Backfill: one default tier per existing event.
INSERT INTO "event_ticket_tiers" ("event_id", "tenant_id", "name", "price_paise", "capacity", "sort_order")
SELECT e."id", e."tenant_id", 'General Admission', e."price_paise", e."capacity", 0
FROM "events" e;
--> statement-breakpoint
-- Backfill: one line per existing non-cancelled event booking, against that
-- event's default tier (the only tier each event now has).
INSERT INTO "event_booking_tickets" ("booking_id", "tier_id", "quantity", "unit_price_paise")
SELECT b."id", t."id", 1, COALESCE(b."base_paise", b."price_paise", 0)
FROM "bookings" b
JOIN "event_ticket_tiers" t ON t."event_id" = (b."item_data"->>'eventId')::uuid
WHERE b."item_type" = 'event' AND b."status" <> 'cancelled';
--> statement-breakpoint
-- Keep events.price_paise as the min tier price (no-op for single-tier today).
UPDATE "events" e
SET "price_paise" = sub.min_price
FROM (
	SELECT "event_id", MIN("price_paise") AS min_price
	FROM "event_ticket_tiers" WHERE "deleted_at" IS NULL GROUP BY "event_id"
) sub
WHERE sub."event_id" = e."id";
