DO $$ BEGIN
  CREATE TYPE "support_issue_status" AS ENUM('unresolved', 'in_progress', 'backlog', 'resolved');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "support_issue_priority" AS ENUM('low', 'medium', 'high');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "support_issues" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id"),
  "message" text NOT NULL,
  "status" "support_issue_status" NOT NULL DEFAULT 'unresolved',
  "priority" "support_issue_priority" NOT NULL DEFAULT 'medium',
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
