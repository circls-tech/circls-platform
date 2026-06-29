CREATE TABLE IF NOT EXISTS "login_events" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id"),
  "source" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "login_events_created_idx"
  ON "login_events" ("created_at");
CREATE INDEX IF NOT EXISTS "login_events_user_created_idx"
  ON "login_events" ("user_id", "created_at");
