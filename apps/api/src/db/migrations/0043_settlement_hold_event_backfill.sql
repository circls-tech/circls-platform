-- Backfill settlement_hold_until for charges whose booking has no time_range
-- (event tickets and memberships' synthetic bookings).
--
-- holdForBooking() used to derive the hold solely from upper(bookings.time_range),
-- so these charges got a NULL hold, were never released by the settlement
-- ticker, and their revenue never entered weekly payout reconciliation — the
-- venue's event/membership sales were invisible in the payouts section forever.
-- The service now anchors the hold on coalesce(slot end, event ends_at,
-- capture time); this backfills the stuck rows with the same rule so the next
-- ticker run (within 5 minutes) releases the overdue ones and the next weekly
-- reconciliation pays them out.
--
-- Buffer: 60 minutes = the SETTLEMENT_HOLD_BUFFER_MIN default (a migration
-- cannot read the env; for rows that are already weeks overdue the exact
-- buffer is immaterial). Text join on eventId matches 0042's precedent: a
-- uuid cast would abort the whole migration on one malformed app-written
-- value.
--
-- Status list matches payout reconciliation's gross filter — a stuck charge
-- that was later (partially) refunded must still release, since its refund
-- rows already deduct from the payout.
UPDATE payments p
SET settlement_hold_until =
      coalesce(upper(b.time_range), e.ends_at, now()) + interval '60 minutes'
FROM bookings b
LEFT JOIN events e ON e.id::text = b.item_data->>'eventId'
WHERE b.id = p.booking_id
  AND p.kind = 'charge'
  AND p.status IN ('captured', 'refunded', 'partially_refunded')
  AND p.settlement_hold_until IS NULL
  AND p.settlement_released_at IS NULL;
