-- "Get help from Circls": a partner org lets Circls super admins into its
-- portal for a few hours. Live while ended_at is null and expires_at is in
-- the future; rows stay as the history of who let Circls in, and when.
CREATE TABLE IF NOT EXISTS "circls_support_grants" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "requested_by_user_id" uuid NOT NULL REFERENCES "users"("id"),
  "note" text,
  "expires_at" timestamp with time zone NOT NULL,
  "ended_at" timestamp with time zone,
  "ended_by_user_id" uuid REFERENCES "users"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "circls_support_grants_tenant_idx"
  ON "circls_support_grants" ("tenant_id", "expires_at");
