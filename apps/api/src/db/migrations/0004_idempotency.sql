CREATE TABLE "idempotency_keys" (
	"key" text PRIMARY KEY NOT NULL,
	"tenant_id" uuid,
	"status_code" integer NOT NULL,
	"response_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
