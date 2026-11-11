'use client';

import { useEffect, useRef, useState } from 'react';
import type * as LeafletModule from 'leaflet';
import type { Map as LeafletMap, Marker as LeafletMarker } from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { CITY_ZOOM, type MapView, type PinCoords } from '@/lib/map_view';

/** Inline SVG pin so we never depend on Leaflet's bundler-hostile image assets. */
const PIN_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="42" viewBox="0 0 30 42">' +
  '<path d="M15 0C6.7 0 0 6.7 0 15c0 11 15 27 15 27s15-16 15-27C30 6.7 23.3 0 15 0z" fill="#6390cc"/>' +
  '<circle cx="15" cy="15" r="6" fill="#fff"/></svg>';

/**
 * The keyless OpenStreetMap map behind {@link MapPinPicker}, used when no
 * Google Maps key is configured (the local sandbox). Its address search then
 * comes from the free providers too — Google results must never be drawn on
 * a non-Google map.
 *
 * Leaflet is loaded dynamically on mount: its dist bundle touches `window` at
 * import time, so a static import would crash the server-side prerender.
 */
export function LeafletPinMap({
  coords,
  initialView,
  unpinnedView,
  onPick,
}: {
  coords: PinCoords | null;
  initialView: MapView;
  /** Where to look while there's no pin. */
  unpinnedView: MapView | null;
  onPick: (c: PinCoords) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const markerRef = useRef<LeafletMarker | null>(null);
  const leafletRef = useRef<typeof LeafletModule | null>(null);
  // Latest onPick, so map event handlers registered once never go stale.
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const [ready, setReady] = useState(false);

  // Create the map once. Destroyed on unmount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const L = await import('leaflet');
      if (cancelled || !containerRef.current || mapRef.current) return;
      leafletRef.current = L;
      const map = L.map(containerRef.current, { scrollWheelZoom: false }).setView(
        [initialView.lat, initialView.lng],
        initialView.zoom,
      );
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19,
      }).addTo(map);
      map.on('click', (e) => {
        onPickRef.current({ lat: e.latlng.lat, lng: e.latlng.lng });
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
        onPickRef.current({ lat: p.lat, lng: p.lng });
      });
      markerRef.current = marker;
    }
    // Keep the pin in view without fighting the user's panning mid-drag.
    if (!map.getBounds().contains([coords.lat, coords.lng])) {
      map.setView([coords.lat, coords.lng], Math.max(map.getZoom(), CITY_ZOOM));
    }
  }, [coords, ready]);

  // While there's no pin, follow the typed city / selected country.
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || coords || !unpinnedView) return;
    map.setView([unpinnedView.lat, unpinnedView.lng], unpinnedView.zoom);
  }, [unpinnedView, coords, ready]);

  return (
    <div
      ref={containerRef}
      className="h-64 w-full rounded-[var(--radius)] border border-[#e5e7eb]"
      // Leaflet needs an explicit height before it can size its panes.
      style={{ minHeight: '16rem' }}
    />
  );
}
