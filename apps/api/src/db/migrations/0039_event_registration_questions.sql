-- Custom event registration questions: organisers attach questions to an event
-- while drafting it ("T-shirt size?", "Dietary restrictions?"); consumers answer
-- at booking time. Questions mirror ticket tiers (draft-only replace-all,
-- soft-delete so history survives); answers mirror event_booking_tickets (one
-- row per question per booking, label snapshotted for exports).

CREATE TABLE "event_registration_questions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"event_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"label" text NOT NULL,
	"type" text DEFAULT 'text' NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"options" jsonb,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "event_registration_questions_type_chk" CHECK ("type" IN ('text', 'select'))
);
--> statement-breakpoint
CREATE TABLE "event_registration_answers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"booking_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"question_label" text NOT NULL,
	"answer" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "event_registration_questions" ADD CONSTRAINT "event_registration_questions_event_id_events_id_fk"
	FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "event_registration_questions" ADD CONSTRAINT "event_registration_questions_tenant_id_tenants_id_fk"
	FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "event_registration_answers" ADD CONSTRAINT "event_registration_answers_booking_id_bookings_id_fk"
	FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "event_registration_answers" ADD CONSTRAINT "event_registration_answers_question_id_fk"
	FOREIGN KEY ("question_id") REFERENCES "public"."event_registration_questions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "event_registration_questions_event_id_idx" ON "event_registration_questions" ("event_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "event_registration_answers_booking_question_uq" ON "event_registration_answers" ("booking_id", "question_id");
--> statement-breakpoint
CREATE INDEX "event_registration_answers_question_id_idx" ON "event_registration_answers" ("question_id");
