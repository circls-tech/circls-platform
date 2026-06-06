CREATE TABLE IF NOT EXISTS "consumer_activity" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id"),
  "session_id" text,
  "event_type" text NOT NULL,
  "item_type" text,
  "item_id" uuid,
  "props" jsonb,
  "client_ts" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "consumer_activity_user_created_idx"
  ON "consumer_activity" ("user_id", "created_at");
