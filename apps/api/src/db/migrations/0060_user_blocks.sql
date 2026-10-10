-- A consumer's personal block on question threads (App Store guideline 1.2):
-- the blocked user's public threads and replies are no longer shown to the
-- blocker. Placed by thread/message and resolved to the author server-side,
-- so the blocker never sees the blocked user's id.
CREATE TABLE "user_blocks" (
  "blocker_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "blocked_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("blocker_user_id", "blocked_user_id")
);
