-- Per-tier QR-ticket override on membership plan tiers. null = the tier
-- inherits the membership's own qr_ticket_config; {"enabled": false} = QR
-- passes explicitly off for this tier; an enabled config replaces the plan's
-- rules wholesale (tiers can differ in scan caps / validity offsets because
-- their benefits differ). Applied at issuance only — already-minted tickets
-- stay frozen.

ALTER TABLE "membership_tiers" ADD COLUMN IF NOT EXISTS "qr_ticket_config" jsonb;
