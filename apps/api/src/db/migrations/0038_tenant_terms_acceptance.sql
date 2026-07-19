-- Partner Terms & Conditions acceptance. One acceptance covers the org:
-- which regional document ('US' | 'IN'), which revision, when, and by whom.
-- Left null for existing tenants — the portal gates them until an
-- owner/manager accepts the current version.

ALTER TABLE "tenants" ADD COLUMN "terms_version" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "terms_region" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "terms_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "terms_accepted_by_user_id" uuid;
