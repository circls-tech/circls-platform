'use client';

import { useMemo, useState } from 'react';

const IST_FMT = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** `commissionBps` / `starts_at` → "Commission bps" / "Starts at". */
function humanizeKey(key: string): string {
  const words = key
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Renders a stored value the way an admin reads it rather than the way it is
 * stored: money out of minor units, rates out of basis points, instants in IST.
 * The key drives the unit, since the value alone can't say whether 5000 is five
 * thousand paise or fifty percent.
 */
function humanizeValue(key: string, v: unknown): string {
  if (v === null || v === undefined) return 'nothing';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'number') {
    if (/paise$/i.test(key)) {
      return (v / 100).toLocaleString('en-IN', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    }
    if (/bps$/i.test(key)) return `${(v / 100).toFixed(2)}%`;
    return String(v);
  }
  if (typeof v === 'string') {
    if (ISO_DATE.test(v)) {
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) return IST_FMT.format(d);
    }
    return v === '' ? 'blank' : v;
  }
  return JSON.stringify(v);
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

interface DiffLine {
  key: string;
  from: string | null;
  to: string | null;
}

/**
 * Turns the before/after blobs into one line per field that actually moved.
 * Fields present in both but unchanged are dropped — an audit row for a single
 * status flip otherwise buries it under a dozen identical values.
 *
 * Many writers store `after` as a partial patch (only the columns they set), so
 * a key missing from `after` means "untouched", not "cleared", and is skipped.
 * A key only in `after` is shown as its new value alone.
 */
function diffLines(before: unknown, after: unknown): DiffLine[] {
  const b = asRecord(before);
  const a = asRecord(after);
  if (!b && !a) return [];
  const keys = [...new Set([...Object.keys(b ?? {}), ...Object.keys(a ?? {})])].sort();
  const lines: DiffLine[] = [];
  for (const key of keys) {
    const bv = b?.[key];
    const av = a?.[key];
    if (b && a) {
      if (!(key in a)) continue;
      if (JSON.stringify(bv) === JSON.stringify(av)) continue;
    }
    lines.push({
      key,
      from: b && key in b ? humanizeValue(key, bv) : null,
      to: a ? humanizeValue(key, av) : null,
    });
  }
  return lines;
}

export function AuditDiff({ before, after }: { before: unknown; after: unknown }) {
  const [view, setView] = useState<'none' | 'summary' | 'raw'>('none');
  const hasDiff = before != null || after != null;
  const lines = useMemo(() => diffLines(before, after), [before, after]);
  if (!hasDiff) return <span className="text-xs text-slate-400">—</span>;

  // What the row did, in words, before the field list.
  const headline =
    before == null ? 'Created' : after == null ? 'Removed' : 'Changed';

  function toggle(next: 'summary' | 'raw') {
    setView((v) => (v === next ? 'none' : next));
  }

  return (
    <div>
      <span className="flex gap-2">
        <button
          type="button"
          onClick={() => toggle('summary')}
          aria-expanded={view === 'summary'}
          className="text-xs font-medium text-blue-700 hover:underline"
        >
          {view === 'summary' ? 'Hide' : 'Summary'}
        </button>
        <button
          type="button"
          onClick={() => toggle('raw')}
          aria-expanded={view === 'raw'}
          className="text-xs font-medium text-slate-500 hover:underline"
        >
          {view === 'raw' ? 'Hide' : 'Raw'}
        </button>
      </span>

      {view === 'summary' && (
        <div className="mt-2 max-w-md rounded bg-slate-50 p-2 text-xs text-slate-700">
          <p className="mb-1 font-medium text-slate-800">{headline}</p>
          {lines.length === 0 ? (
            <p className="text-slate-400">No field values changed.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {lines.map((l) => (
                <li key={l.key} className="break-words">
                  <span className="text-slate-500">{humanizeKey(l.key)}:</span>{' '}
                  {l.from !== null && l.to !== null ? (
                    <>
                      <span className="line-through decoration-slate-400">{l.from}</span>
                      <span className="mx-1 text-slate-400">→</span>
                      <span className="font-medium text-slate-900">{l.to}</span>
                    </>
                  ) : (
                    <span className="font-medium text-slate-900">{l.to ?? l.from}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {view === 'raw' && (
        <pre className="mt-2 max-w-md overflow-auto rounded bg-slate-50 p-2 text-xs text-slate-700 whitespace-pre-wrap break-all">
          {JSON.stringify({ before, after }, null, 2)}
        </pre>
      )}
    </div>
  );
}
