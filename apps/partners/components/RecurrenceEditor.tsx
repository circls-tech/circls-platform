'use client';

import { useEffect, useMemo, useState } from 'react';
import type { OccurrenceInput } from '@/lib/api/events';
import { TiersEditor, tiersToPayload, type TierDraft } from '@/components/TiersEditor';
import { type CurrencyCode } from '@/lib/currency';
import { Button, Input } from '@/lib/ui';

/** Server cap on dates per series (see MAX_SERIES_OCCURRENCES in the API). */
export const MAX_OCCURRENCES = 104;

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** One generated date of the series, plus any Advanced-settings overrides. */
export interface OccurrenceDraft {
  /** YYYY-MM-DD (venue-local calendar date). */
  date: string;
  startTime: string; // HH:mm
  endTime: string; // HH:mm
  /** True once the user edits this row's times (survives regeneration). */
  timeEdited: boolean;
  /** undefined = same venue/address as the event; a venue id moves this date. */
  venueId?: string;
  /** null = same ticket tiers as the event. */
  tiers: TierDraft[] | null;
  removed: boolean;
}

export interface RecurrenceValue {
  mode: 'once' | 'weekly';
  /** 0 = Sunday … 6 = Saturday. */
  weekdays: number[];
  /** Last calendar date of the series (YYYY-MM-DD), inclusive. */
  until: string;
  drafts: OccurrenceDraft[];
}

export function emptyRecurrence(): RecurrenceValue {
  return { mode: 'once', weekdays: [], until: '', drafts: [] };
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function weekdayOf(isoDate: string): number {
  return new Date(`${isoDate}T00:00:00Z`).getUTCDay();
}

function prettyDate(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

/**
 * Expand the weekly rule into per-date drafts, starting at the base start date.
 * Rows the user already touched (time edits, venue/tier overrides, removals)
 * are preserved by calendar date; untouched rows track the base times.
 */
export function generateDrafts(
  baseStartLocal: string,
  baseEndLocal: string,
  weekdays: number[],
  until: string,
  prev: OccurrenceDraft[],
): OccurrenceDraft[] {
  if (!baseStartLocal || !baseEndLocal || weekdays.length === 0 || !until) return [];
  const [startDate, startTime] = baseStartLocal.split('T') as [string, string];
  const endTime = (baseEndLocal.split('T')[1] ?? startTime) as string;
  if (until < startDate) return [];

  const prevByDate = new Map(prev.map((d) => [d.date, d]));
  const out: OccurrenceDraft[] = [];
  for (let date = startDate; date <= until && out.length < MAX_OCCURRENCES; date = addDays(date, 1)) {
    if (!weekdays.includes(weekdayOf(date))) continue;
    const existing = prevByDate.get(date);
    if (existing) {
      out.push(
        existing.timeEdited ? existing : { ...existing, startTime, endTime },
      );
    } else {
      out.push({ date, startTime, endTime, timeEdited: false, tiers: null, removed: false });
    }
  }
  return out;
}

/**
 * Build the API `occurrences` payload from the drafts. `tzFor` resolves the
 * IANA timezone for a date (per its override venue, or the event's own scope);
 * `toIso` converts a "YYYY-MM-DDTHH:mm" local string in that tz to UTC ISO.
 * An end time at or before the start time means the date runs overnight.
 */
export function occurrencePayloads(
  value: RecurrenceValue,
  tzFor: (venueId: string | undefined) => string,
  toIso: (local: string, tz: string) => string,
): OccurrenceInput[] {
  return value.drafts
    .filter((d) => !d.removed)
    .map((d) => {
      const tz = tzFor(d.venueId);
      const endDate = d.endTime <= d.startTime ? addDays(d.date, 1) : d.date;
      return {
        startsAt: toIso(`${d.date}T${d.startTime}`, tz),
        endsAt: toIso(`${endDate}T${d.endTime}`, tz),
        ...(d.venueId ? { venueId: d.venueId } : {}),
        ...(d.tiers ? { tiers: tiersToPayload(d.tiers) } : {}),
      };
    });
}

/**
 * Recurring-event editor for the create forms: one-time vs weekly toggle,
 * weekday + until pickers, and an Advanced settings panel where individual
 * dates can change time or venue, use custom ticket tiers, or be removed.
 */
export function RecurrenceEditor({
  value,
  onChange,
  baseStartLocal,
  baseEndLocal,
  venues,
  baseLocationLabel,
  baseTiers,
  currency,
}: {
  value: RecurrenceValue;
  onChange: (v: RecurrenceValue) => void;
  /** The event form's start/end (datetime-local strings) — first date + times. */
  baseStartLocal: string;
  baseEndLocal: string;
  /** Tenant venues offered as per-date overrides. */
  venues: Array<{ id: string; name: string }>;
  /** What "no override" means, e.g. "Same as event — Indiranagar Arena". */
  baseLocationLabel: string;
  /** The event's tiers — seeds a date's custom tickets when first enabled. */
  baseTiers: TierDraft[];
  /** Currency for per-date ticket prices — follows the event's venue currency. */
  currency: CurrencyCode;
}) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [tiersOpenFor, setTiersOpenFor] = useState<string | null>(null);

  // Regenerate the date list whenever the rule or the base window changes.
  const weekdaysKey = value.weekdays.join(',');
  useEffect(() => {
    if (value.mode !== 'weekly') return;
    const drafts = generateDrafts(
      baseStartLocal,
      baseEndLocal,
      value.weekdays,
      value.until,
      value.drafts,
    );
    const key = (ds: OccurrenceDraft[]) =>
      ds.map((d) => `${d.date} ${d.startTime}-${d.endTime}`).join('|');
    if (key(drafts) !== key(value.drafts)) onChange({ ...value, drafts });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.mode, weekdaysKey, value.until, baseStartLocal, baseEndLocal]);

  const active = useMemo(() => value.drafts.filter((d) => !d.removed), [value.drafts]);

  function setMode(mode: 'once' | 'weekly') {
    if (mode === value.mode) return;
    if (mode === 'weekly' && value.weekdays.length === 0 && baseStartLocal) {
      // Sensible default: repeat on the weekday of the first date.
      onChange({ ...value, mode, weekdays: [weekdayOf(baseStartLocal.slice(0, 10))] });
    } else {
      onChange({ ...value, mode });
    }
  }

  function toggleWeekday(d: number) {
    const weekdays = value.weekdays.includes(d)
      ? value.weekdays.filter((x) => x !== d)
      : [...value.weekdays, d].sort();
    onChange({ ...value, weekdays });
  }

  function patchDraft(date: string, patch: Partial<OccurrenceDraft>) {
    onChange({
      ...value,
      drafts: value.drafts.map((d) => (d.date === date ? { ...d, ...patch } : d)),
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium uppercase tracking-wide text-[#475569]">Repeats</label>
        <div className="inline-flex w-fit rounded-md border border-slate-200 bg-white p-0.5">
          {(['once', 'weekly'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={[
                'rounded px-3 py-1.5 text-sm font-medium transition-colors',
                value.mode === m ? 'bg-slate-900 text-white' : 'text-slate-600 hover:text-slate-900',
              ].join(' ')}
            >
              {m === 'once' ? 'One time' : 'Repeats weekly'}
            </button>
          ))}
        </div>
      </div>

      {value.mode === 'weekly' && (
        <div className="flex flex-col gap-3 rounded-[var(--radius)] border border-[#e5e7eb] bg-slate-50 p-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium uppercase tracking-wide text-[#475569]">On days</label>
            <div className="flex flex-wrap gap-1.5">
              {WEEKDAY_LABELS.map((label, d) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => toggleWeekday(d)}
                  className={[
                    'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                    value.weekdays.includes(d)
                      ? 'border-slate-900 bg-slate-900 text-white'
                      : 'border-slate-200 bg-white text-slate-600 hover:border-slate-400',
                  ].join(' ')}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="max-w-xs">
            <Input
              label="Until (last date)"
              type="date"
              value={value.until}
              min={baseStartLocal ? baseStartLocal.slice(0, 10) : undefined}
              onChange={(e) => onChange({ ...value, until: e.target.value })}
            />
          </div>

          {!baseStartLocal || !baseEndLocal ? (
            <p className="text-xs text-slate-500">
              Set the start and end time above — they define the first date and the time each date runs.
            </p>
          ) : active.length > 0 ? (
            <p className="text-xs text-slate-600">
              <span className="font-medium">{active.length} date{active.length === 1 ? '' : 's'}</span>
              {' '}— {prettyDate(active[0]!.date)} to {prettyDate(active[active.length - 1]!.date)}
              {active.length >= MAX_OCCURRENCES ? ` (capped at ${MAX_OCCURRENCES})` : ''}
              {active.length === 1 ? ' · a recurring event needs at least 2 dates' : ''}
            </p>
          ) : value.until && value.weekdays.length > 0 ? (
            <p className="text-xs text-amber-600">
              No dates fall on the selected days before {prettyDate(value.until)}.
            </p>
          ) : null}

          {value.drafts.length > 0 && (
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => setShowAdvanced((s) => !s)}
                className="w-fit text-sm font-medium text-slate-700 underline-offset-2 hover:underline"
              >
                {showAdvanced ? '▾ Advanced settings' : '▸ Advanced settings'}
                <span className="ml-1 font-normal text-slate-400">
                  — change the time, venue or tickets of individual dates, or skip dates
                </span>
              </button>

              {showAdvanced && (
                <ul className="flex flex-col divide-y divide-slate-200 rounded border border-slate-200 bg-white">
                  {value.drafts.map((d) => (
                    <li key={d.date} className={`flex flex-col gap-2 p-2 ${d.removed ? 'opacity-50' : ''}`}>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="w-24 shrink-0 text-sm font-medium text-slate-800">
                          {prettyDate(d.date)}
                        </span>
                        <input
                          type="time"
                          value={d.startTime}
                          disabled={d.removed}
                          onChange={(e) =>
                            patchDraft(d.date, { startTime: e.target.value, timeEdited: true })
                          }
                          className="rounded border border-[#e5e7eb] bg-white px-2 py-1 text-sm text-[#0f172a]"
                        />
                        <span className="text-xs text-slate-400">to</span>
                        <input
                          type="time"
                          value={d.endTime}
                          disabled={d.removed}
                          onChange={(e) =>
                            patchDraft(d.date, { endTime: e.target.value, timeEdited: true })
                          }
                          className="rounded border border-[#e5e7eb] bg-white px-2 py-1 text-sm text-[#0f172a]"
                        />
                        <select
                          value={d.venueId ?? ''}
                          disabled={d.removed}
                          onChange={(e) =>
                            patchDraft(d.date, {
                              venueId: e.target.value || undefined,
                            })
                          }
                          className="min-w-40 flex-1 rounded border border-[#e5e7eb] bg-white px-2 py-1 text-sm text-[#0f172a]"
                        >
                          <option value="">{baseLocationLabel}</option>
                          {venues.map((v) => (
                            <option key={v.id} value={v.id}>{v.name}</option>
                          ))}
                        </select>
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          onClick={() =>
                            setTiersOpenFor(tiersOpenFor === d.date ? null : d.date)
                          }
                          disabled={d.removed}
                        >
                          {d.tiers ? 'Custom tickets ✓' : 'Tickets'}
                        </Button>
                        <button
                          type="button"
                          onClick={() => patchDraft(d.date, { removed: !d.removed })}
                          className={`rounded px-2 py-1 text-xs font-medium ${
                            d.removed
                              ? 'text-slate-600 hover:bg-slate-100'
                              : 'text-red-600 hover:bg-red-50'
                          }`}
                        >
                          {d.removed ? 'Restore' : 'Skip'}
                        </button>
                      </div>

                      {tiersOpenFor === d.date && !d.removed && (
                        <div className="rounded border border-slate-200 bg-slate-50 p-2">
                          {d.tiers ? (
                            <div className="flex flex-col gap-2">
                              <TiersEditor
                                value={d.tiers}
                                onChange={(tiers) => patchDraft(d.date, { tiers })}
                                currency={currency}
                              />
                              <button
                                type="button"
                                onClick={() => patchDraft(d.date, { tiers: null })}
                                className="w-fit text-xs font-medium text-slate-500 hover:text-slate-800"
                              >
                                Use the event&apos;s tickets for this date
                              </button>
                            </div>
                          ) : (
                            <p className="text-xs text-slate-500">
                              This date uses the event&apos;s ticket tiers.{' '}
                              <button
                                type="button"
                                onClick={() =>
                                  patchDraft(d.date, {
                                    tiers: baseTiers.map((t) => ({ ...t })),
                                  })
                                }
                                className="font-medium text-slate-700 underline-offset-2 hover:underline"
                              >
                                Set custom tickets for this date
                              </button>
                            </p>
                          )}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
