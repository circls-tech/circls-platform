'use client';

import { useEffect, useRef, useState } from 'react';
import {
  resolvePlace,
  searchAddress,
  type AddressSuggestion,
  type GeocoderProvider,
} from '@/lib/api/geocode';
import { GOOGLE_MAP_ENABLED } from '@/lib/map_view';

/** Each billed Google search request counts, so wait for a real query. */
const MIN_QUERY = 3;
const DEBOUNCE_MS = 400;

/**
 * Type-ahead address search for the venue form. Debounces input, queries the
 * API's geocode search, and hands the picked suggestion back to the parent to
 * fill the structured address fields + coordinates. Optional `country` scopes
 * results. Purely a convenience — the manual fields below stay editable.
 *
 * With Google behind the search, one search's keystrokes share a session
 * token, and resolving the pick with the same token ends the session — which
 * is what caps its billed requests. Google results carry a "Google Maps"
 * credit, as Google's terms require when they're shown off its map.
 */
export function AddressAutocomplete({
  country,
  onSelect,
}: {
  country?: string | null;
  /** Always a resolved suggestion: coordinates and address parts filled in. */
  onSelect: (s: AddressSuggestion) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<AddressSuggestion[]>([]);
  const [provider, setProvider] = useState<GeocoderProvider | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [failed, setFailed] = useState(false);
  // Google results with no Google map to show them on (a misconfigured build).
  const [unavailable, setUnavailable] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  // One session per search, from the first keystroke to the pick.
  const sessionRef = useRef<string | null>(null);

  // Debounced search. A stale-guard flag drops out-of-order responses.
  useEffect(() => {
    const q = query.trim();
    if (q.length < MIN_QUERY) {
      setResults([]);
      setLoading(false);
      // An abandoned search ends its session: the next one starts afresh
      // rather than reusing a token Google has expired.
      sessionRef.current = null;
      return;
    }
    sessionRef.current ??= newSessionToken();
    let active = true;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await searchAddress(q, country, sessionRef.current);
        if (!active) return;
        // Google's terms forbid its results on the OpenStreetMap map, which is
        // what a portal built without the Google key shows.
        if (res.provider === 'google' && !GOOGLE_MAP_ENABLED) {
          console.error('Address search is on Google but the portal has no Google map (NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY).');
          setResults([]);
          setUnavailable(true);
          return;
        }
        setUnavailable(false);
        setResults(res.suggestions);
        setProvider(res.provider);
        setOpen(true);
      } catch {
        if (active) setResults([]);
      } finally {
        if (active) setLoading(false);
      }
    }, DEBOUNCE_MS);
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

  async function pick(s: AddressSuggestion) {
    setFailed(false);
    let picked = s;
    if (s.lat == null && s.placeId) {
      setResolving(true);
      try {
        picked = await resolvePlace(s.placeId, sessionRef.current);
      } catch {
        setFailed(true);
        return;
      } finally {
        setResolving(false);
      }
    }
    onSelect(picked);
    sessionRef.current = null;
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
        placeholder="Start typing an address, place or city…"
        className="w-full rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-3 py-2 text-sm text-[#0f172a] placeholder:text-[#94a3b8] hover:border-slate-300"
        autoComplete="off"
      />
      <span className={`text-xs ${failed || unavailable ? 'text-red-600' : 'text-gray-400'}`}>
        {unavailable
          ? 'Address search is unavailable right now — fill the fields below.'
          : failed
            ? "Couldn't load that address — pick it again, or fill the fields below."
            : 'Pick a result to fill the address and map location automatically.'}
      </span>

      {open && (loading || results.length > 0) && (
        <ul className="absolute top-full z-10 mt-1 max-h-64 w-full overflow-y-auto rounded-[var(--radius)] border border-gray-200 bg-white py-1 shadow-lg">
          {loading && results.length === 0 ? (
            <li className="px-3 py-2 text-sm text-gray-400">Searching…</li>
          ) : (
            results.map((s, i) => (
              <li key={`${s.placeId ?? s.label}-${i}`}>
                <button
                  type="button"
                  disabled={resolving}
                  onClick={() => void pick(s)}
                  className="block w-full px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50 disabled:cursor-wait disabled:opacity-60"
                >
                  {s.label}
                </button>
              </li>
            ))
          )}
          {provider === 'google' && results.length > 0 && (
            <li className="border-t border-gray-100 px-3 pb-1 pt-2 text-right text-[11px] text-gray-500">
              Google Maps
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

/** A Google session token: URL-safe, at most 36 characters (a UUID is). */
function newSessionToken(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
