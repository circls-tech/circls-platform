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
import { reverseGeocode, useUpcomingEvents, useVenues } from '@/lib/api/consumer';
import { Button, Modal } from '@/lib/ui';
import {
  countryForCity,
  derivePlaces,
  eventToLocatable,
  nearestCity,
  sameCountry,
  venueToLocatable,
  type AreaSelection,
  type CityOption,
  type Coords,
} from './geo';

// v4 adds `placeLabel` (the reverse-geocoded name of the user's actual place,
// shown when they're outside every served city). The key bump abandons v3
// entries, so previously-located users go through the auto-locate flow once
// more and pick up a label instead of a bare country.
const STORAGE_KEY = 'circls:loc:v4';
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
  /**
   * The user's shared device position, or null when the area was picked
   * manually (or nothing is set). When present, events are restricted to
   * NEARBY_RADIUS_KM around it.
   */
  coords: Coords | null;
  /**
   * Display-only name of the user's actual place (reverse-geocoded), present
   * only when they located themselves outside every served city. The pin
   * label prefers `city`, then this, then `country`.
   */
  placeLabel: string | null;
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

  const [sel, setSel] = useState<AreaSelection>({ city: null, country: null, coords: null });
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
        const coords =
          typeof parsed.coords?.lat === 'number' && typeof parsed.coords?.lng === 'number'
            ? { lat: parsed.coords.lat, lng: parsed.coords.lng }
            : null;
        setSel({
          city: parsed.city ?? null,
          country: parsed.country ?? null,
          coords,
          placeLabel: typeof parsed.placeLabel === 'string' ? parsed.placeLabel : null,
        });
      }
    } catch {
      /* localStorage unavailable or malformed — fall through to the auto-ask flow */
    }
    setHydrated(true);
  }, []);

  const persist = useCallback((next: AreaSelection) => {
    setSel(next);
    try {
      if (next.city || next.country || next.coords) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } else localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore persistence failures */
    }
  }, []);

  // Picking a city in the manual list implies its country; null clears both
  // (browse everywhere). A manual pick always drops coords: the user asked for
  // that city's events, not "within 50 km of me".
  const setCity = useCallback(
    (next: string | null) => {
      persist(
        next
          ? { city: next, country: countryForCity(cities, next), coords: null, placeLabel: null }
          : { city: null, country: null, coords: null, placeLabel: null },
      );
      setPickerOpen(false);
    },
    [persist, cities],
  );

  const openPicker = useCallback(() => setPickerOpen(true), []);

  // Ask the browser for the user's position and map it to the nearest known city.
  // We always adopt that city's COUNTRY (the nearest market — what events filter
  // by); the city name is adopted only when the user is actually near it. Farther
  // away, a best-effort reverse geocode names the user's ACTUAL place so the pin
  // reads "Delhi" rather than the bare country — display-only, never a filter.
  // With no geolocated cities at all, or on denial/error, fall back to the picker.
  const locate = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setPickerOpen(true);
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const coords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        const near = nearestCity(coords, cities);
        if (near && near.distanceKm <= NEAR_CITY_KM) {
          setLocating(false);
          persist({ city: near.city.city, country: near.city.country, coords, placeLabel: null });
          setPickerOpen(false);
          return;
        }
        // Outside every served city — name where the user actually is. The
        // spinner stays up for this one extra round-trip; on failure the pin
        // falls back to the country (or "Set location") as before.
        const place = await reverseGeocode(coords.lat, coords.lng);
        setLocating(false);
        if (!near) {
          // No geolocated city to name the area after, but the position itself
          // still drives the events radius — keep it and let the user pick a
          // city label manually.
          persist({ city: null, country: null, coords, placeLabel: place?.city ?? null });
          setPickerOpen(true);
          return;
        }
        persist({
          city: null,
          country: near.city.country,
          coords,
          placeLabel: place?.city ?? null,
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
    if (sel.city || sel.country || sel.coords) return; // user already has a saved choice
    if (cities.length === 0) return; // wait for venues/events to load
    autoAsked.current = true;
    locate();
  }, [hydrated, sel, cities, locate]);

  const value = useMemo(
    () => ({
      city: sel.city,
      country: sel.country,
      coords: sel.coords ?? null,
      placeLabel: sel.placeLabel ?? null,
      cities,
      setCity,
      openPicker,
      locating,
    }),
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
  // Users browse one market at a time: with an active country, the picker only
  // offers that country's cities (untagged cities stay visible — we can't prove
  // they're foreign). "Show everything, everywhere" clears the country, and the
  // full cross-country list comes back.
  const visibleCities = currentCountry
    ? cities.filter((c) => !c.country || sameCountry(c.country, currentCountry))
    : cities;
  return (
    <Modal open={open} onClose={onClose} title="Choose your city">
      <p className="-mt-2 mb-4 text-sm text-text-secondary">
        Use your current location to see events near you, or pick a city to see
        everything happening there.
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

      {visibleCities.length === 0 ? (
        <p className="text-sm text-text-secondary">No cities available yet.</p>
      ) : (
        <ul className="flex max-h-[40vh] flex-col gap-2 overflow-y-auto">
          {visibleCities.map((c) => (
            <li key={c.city}>
              <button
                onClick={() => onPick(c.city)}
                className={`flex w-full items-center justify-between rounded-[var(--radius)] border-[2px] px-3.5 py-2.5 text-left font-display font-bold transition-colors ${
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
