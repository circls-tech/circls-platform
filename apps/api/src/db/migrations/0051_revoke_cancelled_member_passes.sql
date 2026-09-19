-- Revoke the entry passes of members who were cancelled before cancelling
-- revoked anything.
--
-- WHY: cancelling a member flipped `user_memberships.status` but left their QR
-- pass `active`. Passes were only ever revoked through their booking, and a
-- free membership's pass has no booking, so a cancelled member kept scanning
-- valid at the door until the pass's own end date. Cancelling now revokes the
-- pass; this catches everyone cancelled before that change.
--
-- Only `active` passes move. A `used` pass is already spent, and a `revoked`
-- one is already where it belongs. Reactivating a member restores their pass,
-- so this is undone member by member if a partner brings one back.
UPDATE "qr_tickets" q
   SET "status" = 'revoked'
  FROM "user_memberships" um
 WHERE um."id" = q."user_membership_id"
   AND um."status" = 'cancelled'
   AND q."status" = 'active';
