'use client';

import { useEffect, useRef, useState } from 'react';
import { searchAddress, type AddressSuggestion } from '@/lib/api/geocode';

/**
 * Type-ahead address search for the venue form. Debounces input, queries the
 * API's geocode search, and hands the picked suggestion back to the parent to
 * fill the structured address fields + coordinates. Optional `country` scopes
 * results. Purely a convenience — the manual fields below stay editable.
 */
export function AddressAutocomplete({
  country,
  onSelect,
}: {
  country?: string | null;
  onSelect: (s: AddressSuggestion) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<AddressSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  // Debounced search. A stale-guard flag drops out-of-order responses.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const hits = await searchAddress(q, country);
        if (active) {
          setResults(hits);
          setOpen(true);
        }
      } catch {
        if (active) setResults([]);
      } finally {
        if (active) setLoading(false);
      }
    }, 300);
    return () => {
      active = false;
      clearTimeout(t);
    };
  }, [query, country]);

  // Close the dropdown on outside click.
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  function pick(s: AddressSuggestion) {
    onSelect(s);
    setQuery('');
    setResults([]);
    setOpen(false);
  }

  return (
    <div className="relative flex flex-col gap-1" ref={boxRef}>
      <label className="text-xs font-medium uppercase tracking-wide text-[#475569]">Search address</label>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => results.length > 0 && setOpen(true)}
        placeholder="Start typing an address or city…"
        className="w-full rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-3 py-2 text-sm text-[#0f172a] placeholder:text-[#94a3b8] hover:border-slate-300"
        autoComplete="off"
      />
      <span className="text-xs text-gray-400">
        Pick a result to fill the address and map location automatically.
      </span>

      {open && (loading || results.length > 0) && (
        <ul className="absolute top-full z-10 mt-1 max-h-64 w-full overflow-y-auto rounded-[var(--radius)] border border-gray-200 bg-white py-1 shadow-lg">
          {loading && results.length === 0 ? (
            <li className="px-3 py-2 text-sm text-gray-400">Searching…</li>
          ) : (
            results.map((s, i) => (
              <li key={`${s.label}-${i}`}>
                <button
                  type="button"
                  onClick={() => pick(s)}
                  className="block w-full px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
                >
                  {s.label}
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
