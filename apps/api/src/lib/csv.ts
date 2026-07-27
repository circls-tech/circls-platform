/**
 * Minimal CSV building for admin export endpoints. Every field is quoted and
 * internal quotes doubled (RFC 4180); rows join with CRLF. A UTF-8 BOM is
 * prepended so Excel opens the file with the right encoding. Mirrors the
 * client-side helper in apps/partners' bookings page.
 */

export function csvField(value: unknown): string {
  let s = value == null ? '' : String(value);
  // Neutralize spreadsheet formula injection: a user-controlled string starting
  // with =, +, -, @ (or tab/CR) would execute as a formula when the export is
  // opened in Excel/Sheets. Only strings need this — numbers can't carry it.
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function csvDocument(headers: string[], rows: unknown[][]): string {
  const lines = [headers, ...rows].map((row) => row.map(csvField).join(','));
  return `﻿${lines.join('\r\n')}`;
}
