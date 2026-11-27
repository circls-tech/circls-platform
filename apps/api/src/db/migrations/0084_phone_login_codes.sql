-- Consumer login codes Circls sends itself (Indian numbers through MSG91,
-- behind MSG91_OTP_ENABLED); every other sign-in stays on Firebase phone auth.
-- Only a hash of each code is stored. The newest row per number is the live
-- code; attempts caps wrong guesses, used_at makes it single-use. The rows are
-- also the send log behind the per-number, per-IP and daily limits, and are
-- purged after 30 days (worker job phone-login-code-purge).

CREATE TABLE "phone_login_codes" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "phone_e164" text NOT NULL,
  "code_hash" text NOT NULL,
  "provider" text NOT NULL,
  "provider_request_id" text,
  "ip" text,
  "attempts" integer DEFAULT 0 NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "phone_login_codes_phone_created_idx" ON "phone_login_codes" ("phone_e164", "created_at");
--> statement-breakpoint
CREATE INDEX "phone_login_codes_ip_created_idx" ON "phone_login_codes" ("ip", "created_at");
--> statement-breakpoint
CREATE INDEX "phone_login_codes_created_idx" ON "phone_login_codes" ("created_at");
