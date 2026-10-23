-- A rejected listing can be fixed and sent to review again. The partner portal
-- reads why it was rejected, and the admin queue flags a resubmission, both
-- from the listing's `listing.rejected` audit rows — looked up by entity.
-- Only those rows are indexed: they are a sliver of the audit log.
CREATE INDEX IF NOT EXISTS "audit_log_listing_rejected_idx"
  ON "audit_log" ("entity_id", "created_at")
  WHERE "action" = 'listing.rejected';
