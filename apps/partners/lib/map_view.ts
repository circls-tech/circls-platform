'use client';

import { useEffect, useState } from 'react';
import { cityCenter } from '@/lib/api/geocode';
import { COUNTRY_CENTROIDS } from '@/lib/countries';

/**
 * A map pin. `placeId` is set only while the pin is exactly where a Google
 * address-search pick put it: those coordinates are Google's, which the API
 * may keep for 30 days, so the save sends the place along (as
 * `coordsPlaceId`). Clicking or dragging the pin makes it the partner's own.
 */
export interface PinCoords {
  lat: number;
  lng: number;
  placeId?: string | null;
}

/** The `coordsPlaceId` a save sends with a pin, if any. */
export function coordsPlaceIdOf(coords: PinCoords | null): { coordsPlaceId?: string } {
  return coords?.placeId ? { coordsPlaceId: coords.placeId } : {};
}

export interface MapView {
  lat: number;
  lng: number;
  zoom: number;
}

/** Zoom levels: a placed pin is street-level, a city is district-level, a country is national. */
export const PIN_ZOOM = 16;
export const CITY_ZOOM = 12;
export const COUNTRY_ZOOM = 4;
const WORLD_VIEW: MapView = { lat: 20, lng: 0, zoom: 2 };

/** Where the map opens: the pin, else the selected country, else the world. */
export function initialMapView(coords: PinCoords | null, country?: string | null): MapView {
  if (coords) return { lat: coords.lat, lng: coords.lng, zoom: PIN_ZOOM };
  const centroid = country ? COUNTRY_CENTROIDS[country] : undefined;
  return centroid ? { ...centroid, zoom: COUNTRY_ZOOM } : WORLD_VIEW;
}

/**
 * The view to show while there's no pin: the typed city once the API knows it
 * (debounced; an unknown city keeps the view where it is), else the selected
 * country. Null until there's something to show, and while `enabled` is false.
 */
export function useUnpinnedView(
  city: string | null | undefined,
  country: string | null | undefined,
  enabled: boolean,
): MapView | null {
  const [view, setView] = useState<MapView | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const q = city?.trim() ?? '';
    if (q.length < 2) {
      const centroid = country ? COUNTRY_CENTROIDS[country] : undefined;
      if (centroid) setView({ ...centroid, zoom: COUNTRY_ZOOM });
      return;
    }
    let active = true;
    const t = setTimeout(async () => {
      try {
        const centre = await cityCenter(q, country);
        if (active && centre) setView({ ...centre, zoom: CITY_ZOOM });
      } catch {
        /* lookup is a convenience — keep the current view on failure */
      }
    }, 500);
    return () => {
      active = false;
      clearTimeout(t);
    };
  }, [city, country, enabled]);
  return view;
}
