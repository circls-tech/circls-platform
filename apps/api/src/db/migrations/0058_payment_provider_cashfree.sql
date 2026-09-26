-- Cashfree as a second INR gateway alongside Razorpay. Which one takes NEW
-- INR orders is the INR_PAYMENT_GATEWAY env switch; existing charges keep
-- their recorded provider for refunds/cancels/webhooks. No backfill.
ALTER TYPE "payment_provider" ADD VALUE IF NOT EXISTS 'cashfree' BEFORE 'stub';
