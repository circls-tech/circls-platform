'use client';

import { initialMapView, ownPin, type PinCoords, useUnpinnedView } from '@/lib/map_view';
import { GooglePinMap } from './GooglePinMap';
import { LeafletPinMap } from './LeafletPinMap';

export type { PinCoords } from '@/lib/map_view';

/** Set at build time. With a key the map is Google's, and so must be the API's
 *  geocoder (GEOCODER_PROVIDER=google); without one it's OpenStreetMap. */
const GOOGLE_MAPS_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY;
/** Google's terms forbid showing its coordinates on another map. */
const PIN_HIDDEN_NOTE =
  "This pin came from Google Maps and can't be shown on this map — click the map to set your own.";
/** Google's demo map ID works for development only. */
const GOOGLE_MAP_ID = process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID || 'DEMO_MAP_ID';

/**
 * Map pin picker for address forms. The map starts wherever the address
 * points — the pin itself when one is set, else the typed city, else the
 * selected country, else a world view. Clicking the map places (or moves) a
 * draggable pin and hands its coordinates to the parent — the same "hand-set
 * coordinates" contract as an autocomplete pick, so the API stores them
 * verbatim instead of geocoding. A pin placed this way has no `placeId`: it
 * is the partner's own, not Google's.
 */
export function MapPinPicker({
  coords,
  onChange,
  city,
  country,
}: {
  /** The current pin, or null when no coordinates are set. */
  coords: PinCoords | null;
  /** Called with the new position whenever the user places or drags the pin. */
  onChange: (c: PinCoords) => void;
  /** Typed city — centres the map while there's no pin. */
  city?: string | null;
  /** Selected country — fallback centre, and scopes the city lookup. */
  country?: string | null;
}) {
  // A Google-sourced pin is never drawn on the OpenStreetMap map — the case
  // where the portal was built without the Google key but the API still
  // geocodes with Google (a half-done rollback, say).
  const hiddenGooglePin = !GOOGLE_MAPS_KEY && Boolean(coords?.placeId);
  const shown = hiddenGooglePin ? null : coords;
  // Only the first value matters: the map keeps its own view after mounting.
  const initialView = initialMapView(shown, country);
  const unpinnedView = useUnpinnedView(city, country, shown === null);
  // Clicking or dragging makes the pin the partner's own: no Google place.
  const pick = (c: PinCoords) => onChange(ownPin(c.lat, c.lng));
  const map = GOOGLE_MAPS_KEY ? (
    <GooglePinMap
      apiKey={GOOGLE_MAPS_KEY}
      mapId={GOOGLE_MAP_ID}
      coords={shown}
      initialView={initialView}
      unpinnedView={unpinnedView}
      onPick={pick}
    />
  ) : (
    <LeafletPinMap coords={shown} initialView={initialView} unpinnedView={unpinnedView} onPick={pick} />
  );

  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium uppercase tracking-wide text-[#475569]">
        Map location
      </label>
      {map}
      <span className="text-xs text-gray-400">
        {hiddenGooglePin
          ? PIN_HIDDEN_NOTE
          : coords
            ? 'Pin set — drag it (or click the map) to adjust the exact spot.'
            : 'Click the map to drop a pin on the exact spot. Until then, the map location comes from the typed address.'}
      </span>
    </div>
  );
}
