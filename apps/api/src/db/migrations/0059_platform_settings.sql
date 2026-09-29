-- Platform-wide settings a platform admin changes at runtime, without a
-- redeploy. First use: which gateway new INR orders go to (admin portal →
-- Payments), overriding the INR_PAYMENT_GATEWAY env default — the manual
-- failover switch between Cashfree and Razorpay. Key/value so the next
-- setting needs no migration.
CREATE TABLE "platform_settings" (
  "key" text PRIMARY KEY NOT NULL,
  "value" jsonb NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by_user_id" uuid REFERENCES "users"("id")
);
