-- Multi-gateway prep (Stripe alongside Razorpay, selected by venue country).
-- No behaviour change: everything still charges INR via Razorpay.
--   1. bookings.currency — ISO 4217 for the row's *_paise amounts (minor
--      units of that currency; the column name predates multi-currency).
--      payments/payouts already carry currency.
--   2. payment_provider gains 'stripe' so the adapter PR needs no migration.
ALTER TABLE "bookings" ADD COLUMN "currency" text DEFAULT 'INR' NOT NULL;
--> statement-breakpoint
ALTER TYPE "payment_provider" ADD VALUE IF NOT EXISTS 'stripe' BEFORE 'stub';
