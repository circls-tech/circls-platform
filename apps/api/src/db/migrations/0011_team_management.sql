-- Team management: tenants.is_platform + tenant_invitations.

ALTER TABLE "tenants" ADD COLUMN "is_platform" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE TABLE "tenant_invitations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" "tenant_role" NOT NULL,
	"invited_by_user_id" uuid NOT NULL,
	"token_prefix" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_user_id" uuid,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenant_invitations" ADD CONSTRAINT "tenant_invitations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tenant_invitations" ADD CONSTRAINT "tenant_invitations_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tenant_invitations" ADD CONSTRAINT "tenant_invitations_accepted_user_id_users_id_fk" FOREIGN KEY ("accepted_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "tenant_invitations_token_prefix_idx" ON "tenant_invitations" ("token_prefix");
--> statement-breakpoint
CREATE INDEX "tenant_invitations_tenant_email_idx" ON "tenant_invitations" ("tenant_id", "email");
--> statement-breakpoint
-- IMMUTABLE predicate only (now() is STABLE and gets rejected). The resend
-- flow UPDATEs the existing row in place, so stale-expired rows don't block.
CREATE UNIQUE INDEX "tenant_invitations_live_uniq" ON "tenant_invitations" ("tenant_id", "email") WHERE "accepted_at" IS NULL AND "revoked_at" IS NULL;
