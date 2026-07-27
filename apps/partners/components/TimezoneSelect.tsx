'use client';
import { useMemo } from 'react';
import { useTimezone } from '@/lib/timezone_context';
import { COMMON_TZS, fmtTzOffset, listTimezones } from '@/lib/time';

/**
 * Compact top-bar control for the portal-wide viewing timezone. "Auto" follows
 * each screen's natural zone (venue time / your local time); picking a specific
 * zone shows every time across the portal in that zone.
 */
export function TimezoneSelect() {
  const { viewingTz, setViewingTz, browserTz } = useTimezone();

  const { common, rest } = useMemo(() => {
    const all = new Set(listTimezones());
    const common = COMMON_TZS.filter((z) => all.has(z));
    const commonSet = new Set<string>(common);
    const rest = [...all].filter((z) => !commonSet.has(z)).sort();
    return { common, rest };
  }, []);

  return (
    <label className="flex items-center gap-1.5 rounded-lg border border-slate-900/30 bg-[#FFD2A1] px-2 py-1 text-xs font-medium text-slate-900 hover:border-slate-900/60" title="Display timezone">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className="shrink-0 text-slate-900"
      >
        <circle cx="12" cy="12" r="10" />
        <path d="M2 12h20" />
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
      </svg>
      <select
        aria-label="Display timezone"
        value={viewingTz ?? ''}
        onChange={(e) => setViewingTz(e.target.value || null)}
        className="max-w-[210px] bg-transparent text-xs font-medium text-slate-900 focus:outline-none"
      >
        <option value="">Auto · venue / local ({fmtTzOffset(browserTz)})</option>
        <optgroup label="Common">
          {common.map((z) => (
            <option key={z} value={z}>
              {z} ({fmtTzOffset(z)})
            </option>
          ))}
        </optgroup>
        <optgroup label="All timezones">
          {rest.map((z) => (
            <option key={z} value={z}>
              {z} ({fmtTzOffset(z)})
            </option>
          ))}
        </optgroup>
      </select>
    </label>
  );
}
