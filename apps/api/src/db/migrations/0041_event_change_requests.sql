-- Live-event edit approval: a partner's proposed change to a published event
-- (name / window / location / tiers) is stored as a jsonb patch and reviewed by
-- circls ops before being applied. `snapshot` freezes the event's values at
-- request time so the admin diff can flag "changed since requested". The
-- partial unique index enforces the product rule of at most ONE pending
-- request per event, race-proof at the DB level.

CREATE TABLE "event_change_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"event_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"patch" jsonb NOT NULL,
	"snapshot" jsonb NOT NULL,
	"reason" text,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_change_requests_status_chk" CHECK ("status" IN ('pending', 'approved', 'rejected', 'withdrawn'))
);
--> statement-breakpoint
ALTER TABLE "event_change_requests" ADD CONSTRAINT "event_change_requests_event_id_events_id_fk"
	FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "event_change_requests" ADD CONSTRAINT "event_change_requests_tenant_id_tenants_id_fk"
	FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "event_change_requests" ADD CONSTRAINT "event_change_requests_requested_by_users_id_fk"
	FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "event_change_requests" ADD CONSTRAINT "event_change_requests_reviewed_by_users_id_fk"
	FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "event_change_requests_pending_uq" ON "event_change_requests" ("event_id") WHERE "status" = 'pending';
--> statement-breakpoint
CREATE INDEX "event_change_requests_event_id_idx" ON "event_change_requests" ("event_id");
--> statement-breakpoint
CREATE INDEX "event_change_requests_status_created_idx" ON "event_change_requests" ("status", "created_at");
