-- Per-tier QR-ticket override on event ticket tiers. null = the tier inherits
-- the event's own qr_ticket_config; {"enabled": false} = QR passes explicitly
-- off for this tier; an enabled config replaces the event's rules wholesale
-- (a VIP multi-day tier can be multi-use with a scan cap while General stays
-- single-entry). Applied at issuance only — already-minted tickets stay frozen.

ALTER TABLE "event_ticket_tiers" ADD COLUMN IF NOT EXISTS "qr_ticket_config" jsonb;
