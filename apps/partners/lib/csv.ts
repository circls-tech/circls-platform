/**
 * Client-side CSV building & download helpers, shared by the pages that offer
 * "Download CSV" on their tables (venue bookings, event registrations).
 */

/** Wrap a value as a CSV field, escaping quotes and forcing string type. */
export function csvField(value: unknown): string {
  const s = value == null ? '' : String(value);
  // Always quote: simplest correct handling of commas, quotes, and newlines.
  return `"${s.replace(/"/g, '""')}"`;
}

/** Build a CSV string (CRLF line endings) from a header row and data rows. */
export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = rows.map((row) => row.map(csvField).join(','));
  return [headers.map(csvField).join(','), ...lines].join('\r\n');
}

/** Trigger a client-side download of `content` as a file named `filename`. */
export function downloadCsv(content: string, filename: string): void {
  // Prepend a UTF-8 BOM so Excel renders the ₹ symbol and other characters correctly.
  const blob = new Blob([`﻿${content}`], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
