-- Venue trust metadata (PR #109). Adds description, amenities, opening hours,
-- contact, and a structured address to venues. `amenities` defaults to an empty
-- array (NOT NULL) to mirror `tags`. Migration number to be reconciled at merge.

ALTER TABLE "venues" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "venues" ADD COLUMN "amenities" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "venues" ADD COLUMN "opening_hours" jsonb;--> statement-breakpoint
ALTER TABLE "venues" ADD COLUMN "contact_phone" text;--> statement-breakpoint
ALTER TABLE "venues" ADD COLUMN "contact_email" text;--> statement-breakpoint
ALTER TABLE "venues" ADD COLUMN "address_line1" text;--> statement-breakpoint
ALTER TABLE "venues" ADD COLUMN "address_line2" text;--> statement-breakpoint
ALTER TABLE "venues" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "venues" ADD COLUMN "state" text;--> statement-breakpoint
ALTER TABLE "venues" ADD COLUMN "postal_code" text;--> statement-breakpoint
ALTER TABLE "venues" ADD COLUMN "country" text;
