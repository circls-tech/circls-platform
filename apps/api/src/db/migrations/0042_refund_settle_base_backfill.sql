-- Backfill settle_base_paise on refund rows of platform-funded-coupon sales.
--
-- Refund rows now carry a NEGATIVE settle_base_paise: the payout-side
-- deduction (refunded customer cash + prorated clawback of any Circls-funded
-- discount). Payout reconciliation falls back to amount_paise when it is NULL,
-- which is already the correct deduction for plain and org-funded-coupon
-- sales — so only refunds whose booking has a funder='platform' redemption
-- need backfilling; everything else stays NULL on purpose.
--
-- Proration matches refund_service.computeSettleRefundPaise exactly:
-- per charge, D = amount_paise + platform discount; the k-th refund deducts
-- floor(cum_refunded_k * D / A) - floor(cum_refunded_{k-1} * D / A), so a
-- completed refund totals exactly D and partials never over-deduct. The
-- explicit floor() is load-bearing: sum() OVER returns numeric, whose
-- division is exact and whose assignment to bigint ROUNDS half-up — without
-- it partial splits drift one paise off the code's BigInt floor math.
WITH plat AS (
  SELECT booking_id, sum(discount_paise) AS discount
  FROM coupon_redemptions
  WHERE funder = 'platform'
  GROUP BY booking_id
), r AS (
  SELECT rf.id,
         c.id AS charge_id,
         rf.created_at,
         sum(-rf.amount_paise) OVER (PARTITION BY c.id ORDER BY rf.created_at, rf.id) AS cum,
         c.amount_paise AS a,
         c.amount_paise + p.discount AS d
  FROM payments rf
  -- Text join: chargePaymentId is app-written but a cast would abort the whole
  -- migration on one malformed value.
  JOIN payments c ON c.id::text = rf.metadata->>'chargePaymentId' AND c.kind = 'charge'
  JOIN plat p ON p.booking_id = rf.booking_id
  WHERE rf.kind = 'refund'
    AND rf.status <> 'failed'
    AND rf.settle_base_paise IS NULL
    AND c.amount_paise > 0
), t AS (
  SELECT id,
         floor((cum * d) / a) AS target,
         coalesce(lag(floor((cum * d) / a)) OVER (PARTITION BY charge_id ORDER BY created_at, id), 0) AS prev
  FROM r
)
UPDATE payments
SET settle_base_paise = -greatest(t.target - t.prev, 0)
FROM t
WHERE payments.id = t.id;
