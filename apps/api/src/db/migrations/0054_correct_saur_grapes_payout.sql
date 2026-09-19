-- Correct the Saur Grapes payout for 17–24 Aug 2026.
--
-- WHY: the reconciler deducted a ₹614.17 refund on a payment the partner never
-- had. Himanshu Pazare booked The Traitors Game Circle on 21 Aug at 12:32 IST;
-- Razorpay reported the payment failed, so the booking was cancelled; at 12:48
-- the same payment succeeded late and was refunded automatically. That charge
-- was never given a settlement hold, so its gross never reached a payout — but
-- its refund (₹600.37 to the customer plus a ₹13.80 circls-funded coupon clawed
-- back) was still deducted. The payout shows ₹10,171.32; it should be ₹10,785.49.
--
-- The code fix stops the reconciler deducting such refunds, but the reconciler
-- never revisits a week that already has a payout row, so this one needs
-- correcting directly.
--
-- Guarded to exactly the row as it stands: still pending, still holding the
-- wrong figures. Anywhere else — another environment, or once someone has paid
-- or corrected it by hand — this matches nothing and changes nothing. The
-- change is recorded in the audit log as payout.corrected.
WITH corrected AS (
  UPDATE "payouts"
     SET "amount_paise"  = "amount_paise"  + 61417,
         "refunds_paise" = "refunds_paise" - 61417
   WHERE "id" = '01a031b6-2b15-7b3f-801d-d5af528086f7'
     AND "status" = 'pending'
     AND "amount_paise" = 1017132
     AND "refunds_paise" = 122868
  RETURNING "id", "tenant_id", "amount_paise", "refunds_paise"
)
INSERT INTO "audit_log" ("tenant_id", "action", "entity_type", "entity_id", "before", "after")
SELECT "tenant_id", 'payout.corrected', 'payout', "id",
       jsonb_build_object('amountPaise', 1017132, 'refundsPaise', 122868),
       jsonb_build_object(
         'amountPaise', "amount_paise",
         'refundsPaise', "refunds_paise",
         'reason', 'Removed a ₹614.17 refund on a payment never credited to the partner (captured after its booking was cancelled, then auto-refunded)',
         'bookingId', '01a02320-f3c1-7173-b2b4-b67a7b42851f',
         'chargePaymentId', '01a02320-f3cf-7caa-b7fe-19e6bdd22566'
       )
  FROM corrected;
