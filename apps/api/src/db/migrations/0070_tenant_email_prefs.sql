-- Which kinds of email an org wants from circls (Settings -> Notifications).
-- Keys: booking, listing. A missing key means the email is on.
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "email_prefs" jsonb DEFAULT '{}'::jsonb NOT NULL;
