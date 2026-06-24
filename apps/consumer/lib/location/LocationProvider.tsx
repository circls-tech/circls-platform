'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useUpcomingEvents, useVenues } from '@/lib/api/consumer';
import { Button, Modal } from '@/lib/ui';
import {
  countryForCity,
  derivePlaces,
  eventToLocatable,
  nearestCity,
  venueToLocatable,
  type AreaSelection,
  type CityOption,
} from './geo';

const STORAGE_KEY = 'circls:loc:v2';
/**
 * Within this distance the user is treated as "in" the nearest city, so we adopt
 * its name (and filter venues by it). Farther away we still adopt the country —
 * it's the nearest market and the right filter for events — but leave the city
 * unset rather than mislabel the user as being in a city across the country.
 */
const NEAR_CITY_KM = 150;

interface LocationContextValue {
  /** The chosen city name, or null when only a country (or nothing) is set. */
  city: string | null;
  /** The active country. Events are filtered by this; venues too (then by city). */
  country: string | null;
  /** Cities derived from existing venues + events, for the manual picker. */
  cities: CityOption[];
  /** Set (or clear, with null) the active city. */
  setCity: (city: string | null) => void;
  /** Open the manual city picker. */
  openPicker: () => void;
  /** True while the browser geolocation prompt is in flight. */
  locating: boolean;
}

const LocationContext = createContext<LocationContextValue | null>(null);

export function useLocation(): LocationContextValue {
  const ctx = useContext(LocationContext);
  if (!ctx) throw new Error('useLocation must be used within <LocationProvider>');
  return ctx;
}

export function LocationProvider({ children }: { children: ReactNode }) {
  // Broad fetches back the city list and nearest-city lookup. React Query dedupes
  // these with the page-level calls. Venues give cities; events add city/country
  // for places that have no venue (e.g. a standalone out-of-country event).
  const venues = useVenues('', 100);
  const events = useUpcomingEvents(100);
  const cities = useMemo(
    () =>
      derivePlaces([
        ...(venues.data ?? []).map(venueToLocatable),
        ...(events.data ?? []).map(eventToLocatable),
      ]),
    [venues.data, events.data],
  );

  const [sel, setSel] = useState<AreaSelection>({ city: null, country: null });
  const [hydrated, setHydrated] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [locating, setLocating] = useState(false);
  const autoAsked = useRef(false);

  // Restore a previously chosen area once, on mount (client only).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<AreaSelection>;
        setSel({ city: parsed.city ?? null, country: parsed.country ?? null });
      }
    } catch {
      /* localStorage unavailable or malformed — fall through to the auto-ask flow */
    }
    setHydrated(true);
  }, []);

  const persist = useCallback((next: AreaSelection) => {
    setSel(next);
    try {
      if (next.city || next.country) localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore persistence failures */
    }
  }, []);

  // Picking a city in the manual list implies its country; null clears both
  // (browse everywhere).
  const setCity = useCallback(
    (next: string | null) => {
      persist(next ? { city: next, country: countryForCity(cities, next) } : { city: null, country: null });
      setPickerOpen(false);
    },
    [persist, cities],
  );

  const openPicker = useCallback(() => setPickerOpen(true), []);

  // Ask the browser for the user's position and map it to the nearest known city.
  // We always adopt that city's COUNTRY (the nearest market — what events filter
  // by); the city name is adopted only when the user is actually near it. With no
  // geolocated cities at all, or on denial/error, fall back to the manual picker.
  const locate = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setPickerOpen(true);
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        const near = nearestCity(
          { lat: pos.coords.latitude, lng: pos.coords.longitude },
          cities,
        );
        if (!near) {
          setPickerOpen(true);
          return;
        }
        persist({
          city: near.distanceKm <= NEAR_CITY_KM ? near.city.city : null,
          country: near.city.country,
        });
        setPickerOpen(false);
      },
      () => {
        setLocating(false);
        setPickerOpen(true);
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 600_000 },
    );
  }, [cities, persist]);

  // Auto-ask exactly once: after hydration, when nothing is stored and the city
  // list is ready. Triggers the native geolocation permission prompt.
  useEffect(() => {
    if (!hydrated || autoAsked.current) return;
    if (sel.city || sel.country) return; // user already has a saved choice
    if (cities.length === 0) return; // wait for venues/events to load
    autoAsked.current = true;
    locate();
  }, [hydrated, sel, cities, locate]);

  const value = useMemo(
    () => ({ city: sel.city, country: sel.country, cities, setCity, openPicker, locating }),
    [sel, cities, setCity, openPicker, locating],
  );

  return (
    <LocationContext.Provider value={value}>
      {children}
      <LocationPickerModal
        open={pickerOpen}
        cities={cities}
        current={sel.city}
        currentCountry={sel.country}
        locating={locating}
        onUseLocation={locate}
        onPick={setCity}
        onClose={() => setPickerOpen(false)}
      />
    </LocationContext.Provider>
  );
}

function LocationPickerModal({
  open,
  cities,
  current,
  currentCountry,
  locating,
  onUseLocation,
  onPick,
  onClose,
}: {
  open: boolean;
  cities: CityOption[];
  current: string | null;
  currentCountry: string | null;
  locating: boolean;
  onUseLocation: () => void;
  onPick: (city: string | null) => void;
  onClose: () => void;
}) {
  return (
    <Modal open={open} onClose={onClose} title="Choose your city">
      <p className="-mt-2 mb-4 text-sm text-text-secondary">
        We&apos;ll show venues in your city and events in your country. Use your
        current location, or pick a city.
      </p>
      <Button
        variant="secondary"
        className="w-full"
        loading={locating}
        onClick={onUseLocation}
      >
        <span aria-hidden>📍</span> Use my current location
      </Button>

      <div className="my-4 h-px bg-ink/10" />

      {cities.length === 0 ? (
        <p className="text-sm text-text-secondary">No cities available yet.</p>
      ) : (
        <ul className="flex max-h-[40vh] flex-col gap-2 overflow-y-auto">
          {cities.map((c) => (
            <li key={c.city}>
              <button
                onClick={() => onPick(c.city)}
                className={`flex w-full items-center justify-between rounded-[var(--radius)] border-[2.5px] px-3.5 py-2.5 text-left font-display font-bold transition-colors ${
                  current === c.city
                    ? 'border-ink bg-coral text-ink'
                    : 'border-ink/15 bg-white text-ink hover:bg-surface-2'
                }`}
              >
                <span>{c.city}</span>
                {c.country && (
                  <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
                    {c.country}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      {(current || currentCountry) && (
        <button
          onClick={() => onPick(null)}
          className="mt-4 text-sm font-semibold text-ink-soft underline hover:text-ink"
        >
          Show everything, everywhere
        </button>
      )}
    </Modal>
  );
}
