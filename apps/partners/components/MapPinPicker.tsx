'use client';

import { useEffect, useRef, useState } from 'react';
import type * as LeafletModule from 'leaflet';
import type { Map as LeafletMap, Marker as LeafletMarker } from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { searchAddress } from '@/lib/api/geocode';
import { COUNTRY_CENTROIDS } from '@/lib/countries';

export interface PinCoords {
  lat: number;
  lng: number;
}

/** Zoom levels: a placed pin is street-level, a city is district-level, a country is national. */
const PIN_ZOOM = 16;
const CITY_ZOOM = 12;
const COUNTRY_ZOOM = 4;
const WORLD_CENTER: PinCoords = { lat: 20, lng: 0 };
const WORLD_ZOOM = 2;

/** Inline SVG pin so we never depend on Leaflet's bundler-hostile image assets. */
const PIN_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="42" viewBox="0 0 30 42">' +
  '<path d="M15 0C6.7 0 0 6.7 0 15c0 11 15 27 15 27s15-16 15-27C30 6.7 23.3 0 15 0z" fill="#cf3f7f"/>' +
  '<circle cx="15" cy="15" r="6" fill="#fff"/></svg>';

/**
 * OpenStreetMap pin picker for address forms. The map starts wherever the
 * address points — the pin itself when one is set, else the typed city (looked
 * up via the API's geocode search), else the selected country, else a world
 * view. Clicking the map places (or moves) a draggable pin and hands its
 * coordinates to the parent — the same "hand-set coordinates" contract as an
 * autocomplete pick, so the API stores them verbatim instead of geocoding.
 *
 * Leaflet is loaded dynamically on mount: its dist bundle touches `window` at
 * import time, so a static import would crash the server-side prerender.
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
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const markerRef = useRef<LeafletMarker | null>(null);
  const leafletRef = useRef<typeof LeafletModule | null>(null);
  // Latest onChange, so map event handlers registered once never go stale.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const [ready, setReady] = useState(false);

  // Create the map once. Destroyed on unmount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const L = await import('leaflet');
      if (cancelled || !containerRef.current || mapRef.current) return;
      leafletRef.current = L;
      const start = coords ?? (country ? COUNTRY_CENTROIDS[country] : null) ?? WORLD_CENTER;
      const zoom = coords ? PIN_ZOOM : country ? COUNTRY_ZOOM : WORLD_ZOOM;
      const map = L.map(containerRef.current, { scrollWheelZoom: false }).setView(
        [start.lat, start.lng],
        zoom,
      );
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19,
      }).addTo(map);
      map.on('click', (e) => {
        onChangeRef.current({ lat: e.latlng.lat, lng: e.latlng.lng });
      });
      mapRef.current = map;
      setReady(true);
    })();
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
      markerRef.current = null;
      setReady(false);
    };
    // Mount-only: the initial view is a starting point, not a controlled value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the marker in sync with the coords prop (placed, moved, or cleared).
  useEffect(() => {
    const L = leafletRef.current;
    const map = mapRef.current;
    if (!ready || !L || !map) return;
    if (!coords) {
      markerRef.current?.remove();
      markerRef.current = null;
      return;
    }
    if (markerRef.current) {
      markerRef.current.setLatLng([coords.lat, coords.lng]);
    } else {
      const marker = L.marker([coords.lat, coords.lng], {
        draggable: true,
        icon: L.divIcon({ className: '', html: PIN_SVG, iconSize: [30, 42], iconAnchor: [15, 42] }),
      }).addTo(map);
      marker.on('dragend', () => {
        const p = marker.getLatLng();
        onChangeRef.current({ lat: p.lat, lng: p.lng });
      });
      markerRef.current = marker;
    }
    // Keep the pin in view without fighting the user's panning mid-drag.
    if (!map.getBounds().contains([coords.lat, coords.lng])) {
      map.setView([coords.lat, coords.lng], Math.max(map.getZoom(), CITY_ZOOM));
    }
  }, [coords, ready]);

  // While there's no pin, follow the typed city (debounced geocode lookup),
  // falling back to the country centre. A placed pin always wins.
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || coords) return;
    const q = city?.trim() ?? '';
    if (q.length < 2) {
      const centroid = country ? COUNTRY_CENTROIDS[country] : undefined;
      if (centroid) map.setView([centroid.lat, centroid.lng], COUNTRY_ZOOM);
      return;
    }
    let active = true;
    const t = setTimeout(async () => {
      try {
        const hits = await searchAddress(q, country);
        const hit = hits[0];
        if (active && hit && mapRef.current) {
          mapRef.current.setView([hit.lat, hit.lng], CITY_ZOOM);
        }
      } catch {
        /* lookup is a convenience — keep the current view on failure */
      }
    }, 500);
    return () => {
      active = false;
      clearTimeout(t);
    };
  }, [city, country, coords, ready]);

  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium uppercase tracking-wide text-[#475569]">
        Map location
      </label>
      <div
        ref={containerRef}
        className="h-64 w-full rounded-[var(--radius)] border border-[#e5e7eb]"
        // Leaflet needs an explicit height before it can size its panes.
        style={{ minHeight: '16rem' }}
      />
      <span className="text-xs text-gray-400">
        {coords
          ? 'Pin set — drag it (or click the map) to adjust the exact spot.'
          : 'Click the map to drop a pin on the exact spot. Until then, the map location comes from the typed address.'}
      </span>
    </div>
  );
}
