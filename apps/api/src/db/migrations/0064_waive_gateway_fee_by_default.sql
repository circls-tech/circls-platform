-- Go-live for the waived-fee checkout: Circls bears the payment-gateway fee
-- for every organisation's customers. Checkout shows the fee struck through
-- as FREE and the customer's total equals the (discounted) base price.
--
-- Every tenant is flipped now, and the column default follows so tenants
-- onboarded later start the same way. A platform admin raises a tenant's
-- customer share back up (e.g. to 100%) per tenant from its Billing tab.
ALTER TABLE "tenants" ALTER COLUMN "customer_fee_share_bps" SET DEFAULT 0;
--> statement-breakpoint
UPDATE "tenants" SET "customer_fee_share_bps" = 0;
--> statement-breakpoint
-- The Circls-wide 2.36% coupon only existed to net the fee out (2.36% is the
-- Razorpay rate incl. GST); with the fee waived it would stack a real
-- discount on top. Pause rather than delete so it stays auditable and can be
-- resumed from the admin console if ever needed.
UPDATE "coupons"
  SET "status" = 'paused'
  WHERE "owner_type" = 'platform'
    AND "discount_type" = 'percent'
    AND "discount_value" = 236
    AND "status" = 'active';
