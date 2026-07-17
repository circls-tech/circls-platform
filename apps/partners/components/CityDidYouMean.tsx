'use client';

import { useEffect, useState } from 'react';
import { suggestCity } from '@/lib/api/geocode';

/**
 * Non-blocking "Did you mean <city>?" hint for a hand-typed City field.
 * Debounces the typed value against the API's city-suggest endpoint (offline
 * gazetteer: aliases, case variants, and small typos of known cities) and, on
 * click, hands the canonical spelling back to the parent — which should apply
 * it through its normal city-change handler so coordinate-clearing etc. behave
 * exactly like a manual edit. Renders nothing when there's no suggestion.
 */
export function CityDidYouMean({
  city,
  country,
  onPick,
}: {
  city: string;
  country?: string | null;
  onPick: (canonical: string) => void;
}) {
  const [suggestion, setSuggestion] = useState<string | null>(null);

  useEffect(() => {
    const q = city.trim();
    if (q.length < 3) {
      setSuggestion(null);
      return;
    }
    let active = true;
    const t = setTimeout(async () => {
      try {
        const s = await suggestCity(q, country);
        // Never suggest what's already typed (case differences aside, the
        // server canonicalizes on save anyway — only surface real changes).
        if (active) setSuggestion(s && s.toLowerCase() !== q.toLowerCase() ? s : null);
      } catch {
        if (active) setSuggestion(null); // a hint, never an error
      }
    }, 400);
    return () => {
      active = false;
      clearTimeout(t);
    };
  }, [city, country]);

  if (!suggestion) return null;
  return (
    <p className="text-xs text-slate-500">
      Did you mean{' '}
      <button
        type="button"
        onClick={() => onPick(suggestion)}
        className="font-medium text-blue-600 underline-offset-2 hover:underline"
      >
        {suggestion}
      </button>
      ?
    </p>
  );
}
