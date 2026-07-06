import { z } from 'zod';
import type { QrTicketConfig } from '../db/schema/qr_ticket_config.js';

/**
 * Shared request-body validator for the `qrTicketConfig` field on the event /
 * arena / membership create+update payloads. `null` clears the config (QR
 * tickets off); omitting the field leaves it unchanged (routes only patch when
 * the key is present).
 */
export const qrTicketConfigSchema = z
  .object({
    enabled: z.boolean(),
    multiUse: z.boolean().optional().default(false),
    maxScans: z.number().int().min(1).max(10_000).nullable().optional().default(null),
    // Offsets are bounded to a year — enough for any real entry window while
    // keeping nonsense (e.g. Number.MAX_SAFE_INTEGER minutes) out of the DB.
    validFromOffsetMin: z.number().int().min(0).max(525_600).nullable().optional().default(null),
    validUntilOffsetMin: z.number().int().min(0).max(525_600).nullable().optional().default(null),
  })
  .nullable();

/** Normalise a parsed payload value to the stored shape (single-use ⇒ no scan cap). */
export function toQrTicketConfig(
  value: z.infer<typeof qrTicketConfigSchema>,
): QrTicketConfig | null {
  if (!value || !value.enabled) return null;
  return {
    enabled: true,
    multiUse: value.multiUse,
    maxScans: value.multiUse ? value.maxScans : null,
    validFromOffsetMin: value.validFromOffsetMin,
    validUntilOffsetMin: value.validUntilOffsetMin,
  };
}
