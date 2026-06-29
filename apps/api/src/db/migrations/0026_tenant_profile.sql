-- Org/brand profile (PR #107). Adds self-editable profile fields + a structured
-- address + a single logo object key to tenants. All nullable; the existing
-- unstructured address_json is kept for back-compat. Migration number to be
-- reconciled at merge (other branches also add migrations).

ALTER TABLE "tenants" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "contact_email" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "contact_phone" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "website_url" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "socials" jsonb;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "address_line1" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "address_line2" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "state" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "postal_code" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "country" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "logo_storage_key" text;
