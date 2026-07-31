'use client';
import { QRCodeSVG } from 'qrcode.react';
import type { QrTicket } from '@/lib/api/types';
import { formatDateTime } from '@/lib/format';
import { Badge, type BadgeTone } from '@/lib/ui';

/** Human-readable scan status, e.g. "Single entry" or "Multi-entry · 2 of 5 scans used". */
function scanStatusLabel(t: QrTicket): string {
  if (t.status === 'used') return 'Used';
  if (t.status === 'revoked') return 'Revoked';
  if (!t.multiUse) return 'Single entry';
  if (t.maxScans != null) return `Multi-entry · ${t.scanCount} of ${t.maxScans} scans used`;
  return t.scanCount > 0 ? `Multi-entry · ${t.scanCount} scans used` : 'Multi-entry';
}

const STATUS_TONES: Record<QrTicket['status'], BadgeTone> = {
  active: 'success',
  used: 'neutral',
  revoked: 'danger',
};

/** "Valid from … / until …" line; null when the ticket has no time bounds. */
function validityLabel(t: QrTicket): string | null {
  if (t.validFrom && t.validUntil) {
    return `Valid from ${formatDateTime(t.validFrom)} until ${formatDateTime(t.validUntil)}`;
  }
  if (t.validFrom) return `Valid from ${formatDateTime(t.validFrom)}`;
  if (t.validUntil) return `Valid until ${formatDateTime(t.validUntil)}`;
  return null;
}

/**
 * One scannable entry ticket: the QR code, its label, validity window, scan
 * status, and the short code as a fallback for manual check-in.
 */
export function QrTicketCard({ ticket }: { ticket: QrTicket }) {
  const inactive = ticket.status !== 'active';
  const validity = validityLabel(ticket);

  return (
    <div className="flex flex-col items-center gap-3 rounded-card border-[2px] border-ink bg-white p-6 text-center">
      <div className={inactive ? 'opacity-30' : undefined}>
        <QRCodeSVG value={ticket.qrData} size={192} includeMargin />
      </div>
      {ticket.label && <p className="text-sm font-medium text-ink">{ticket.label}</p>}
      <Badge tone={STATUS_TONES[ticket.status]} label={scanStatusLabel(ticket)} />
      {validity && <p className="text-sm text-text-secondary">{validity}</p>}
      <p className="text-xs text-text-secondary">
        Can&apos;t scan? Quote code{' '}
        <span className="font-mono font-semibold text-ink">{ticket.code}</span>
      </p>
    </div>
  );
}
