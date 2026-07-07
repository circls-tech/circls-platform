/**
 * Per-listing QR-ticket rules, stored as a `qr_ticket_config` JSONB column on
 * events / arenas / memberships (null = QR tickets disabled). Lives in its own
 * module (no table imports) so those three schema files and `qr_tickets.ts` can
 * all import it without cycles.
 *
 * Offsets are relative to the purchased item's own window (event start/end,
 * booked-slot span, membership period); concrete `valid_from`/`valid_until`
 * instants are computed at issuance time and stored on the ticket row.
 */
export interface QrTicketConfig {
  enabled: boolean;
  /** false = the ticket is consumed by its first successful scan. */
  multiUse: boolean;
  /** Scan cap for multi-use tickets (null = unlimited). Ignored when single-use. */
  maxScans: number | null;
  /** Minutes before the item's start at which the QR becomes valid.
   *  null = valid immediately once issued. */
  validFromOffsetMin: number | null;
  /** Minutes after the item's end at which the QR expires.
   *  null = expires exactly at the item's end. */
  validUntilOffsetMin: number | null;
}
