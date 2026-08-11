-- Consumer account deletion (Google Play / Apple App Store compliance).
--
-- Deleting an account ANONYMISES the users row instead of dropping it: bookings
-- and payments reference users.id and must survive for financial/tax retention
-- and gateway (Razorpay/Stripe) reconciliation, so a hard DELETE is not an
-- option. `deleted_at` is the marker that the row is a tombstone — every
-- identity column on it (firebase_uid, phone_e164, email, display_name,
-- interests) is cleared or re-keyed by the same transaction.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "deleted_at" timestamptz;
