-- Venue media — photos attached to a venue. Bytes live in the public R2
-- bucket; this table holds the object key + metadata only. Hand-written to
-- match the project's post-0009 migration convention (no drizzle snapshots).
CREATE TABLE "venue_images" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"venue_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "venue_images_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
ALTER TABLE "venue_images" ADD CONSTRAINT "venue_images_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "venue_images" ADD CONSTRAINT "venue_images_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "venue_images_venue_idx" ON "venue_images" ("venue_id");
