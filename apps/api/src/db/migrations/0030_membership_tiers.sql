-- Membership tiers: per-membership plan tiers (e.g. Gold / Silver / Bronze),
-- each with its own price, duration, perks (benefits) and optional capacity.
-- Mirrors event ticket tiers. user_memberships gains membership_tier_id so each
-- purchase records the tier it bought (the source of per-tier sold counts).
-- Existing memberships are backfilled into one "Standard" tier (copying their
-- price/duration/benefits) and existing purchases are pointed at it.
-- memberships.price_paise/duration_days/benefits become legacy display fields,
-- kept in sync (cheapest tier) by the app.

CREATE TABLE "membership_tiers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"membership_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"price_paise" bigint DEFAULT 0 NOT NULL,
	"duration_days" integer NOT NULL,
	"benefits" jsonb DEFAULT '{"items":[]}'::jsonb NOT NULL,
	"capacity" integer,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "membership_tiers" ADD CONSTRAINT "membership_tiers_membership_id_memberships_id_fk"
	FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "membership_tiers" ADD CONSTRAINT "membership_tiers_tenant_id_tenants_id_fk"
	FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "user_memberships" ADD COLUMN "membership_tier_id" uuid;
--> statement-breakpoint
CREATE INDEX "membership_tiers_membership_id_idx" ON "membership_tiers" ("membership_id");
--> statement-breakpoint
CREATE INDEX "user_memberships_membership_tier_id_idx" ON "user_memberships" ("membership_tier_id");
--> statement-breakpoint
-- Backfill: one default "Standard" tier per existing membership, carrying its
-- current price/duration/benefits (benefits already in the typed {items:[]} shape).
INSERT INTO "membership_tiers" ("membership_id", "tenant_id", "name", "description", "price_paise", "duration_days", "benefits", "capacity", "sort_order")
SELECT m."id", m."tenant_id", 'Standard', m."description", m."price_paise", m."duration_days", m."benefits", NULL, 0
FROM "memberships" m;
--> statement-breakpoint
-- Backfill: point existing purchases at their membership's single tier.
UPDATE "user_memberships" um
SET "membership_tier_id" = t."id"
FROM "membership_tiers" t
WHERE t."membership_id" = um."membership_id"
  AND um."membership_tier_id" IS NULL;
--> statement-breakpoint
-- Keep memberships.price_paise as the min tier price (no-op for single tier today).
UPDATE "memberships" m
SET "price_paise" = sub.min_price
FROM (
	SELECT "membership_id", MIN("price_paise") AS min_price
	FROM "membership_tiers" WHERE "deleted_at" IS NULL GROUP BY "membership_id"
) sub
WHERE sub."membership_id" = m."id";
