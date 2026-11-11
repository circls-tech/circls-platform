'use client';

import { useEffect, useState } from 'react';
import { cityCenter } from '@/lib/api/geocode';
import { COUNTRY_CENTROIDS } from '@/lib/countries';

/**
 * A map pin. `placeId` is set only while the pin is exactly where a Google
 * address-search pick put it: those coordinates are Google's, which the API
 * may keep for 30 days, so the save sends the place along (as
 * `coordsPlaceId`), with `fetchedAt` — when Google returned them — so a
 * draft saved later, or an event duplicated later, doesn't restart those 30
 * days. Clicking or dragging the pin makes it the partner's own.
 */
export interface PinCoords {
  lat: number;
  lng: number;
  placeId?: string | null;
  /** ISO time Google returned these coordinates; only with `placeId`. */
  fetchedAt?: string | null;
}

/** Set at build time: with a browser key the portal's map is Google's. */
export const GOOGLE_MAP_ENABLED = Boolean(process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY);

/** A pin the partner placed by clicking or dragging: theirs, not Google's. */
export function ownPin(lat: number, lng: number): PinCoords {
  return { lat, lng, placeId: null, fetchedAt: null };
}

/** The `coordsPlaceId` an update sends with a pin, if any. An unchanged pin
 *  keeps its stored fetch time on the server, so updates need no more. */
export function coordsPlaceIdOf(coords: PinCoords | null): { coordsPlaceId?: string } {
  return coords?.placeId ? { coordsPlaceId: coords.placeId } : {};
}

/** What a create sends with a pin: the place and, when known, when Google
 *  returned it — a create has no stored row to keep that time from. */
export function coordsProvenanceOf(
  coords: PinCoords | null,
): { coordsPlaceId?: string; coordsFetchedAt?: string } {
  if (!coords?.placeId) return {};
  return {
    coordsPlaceId: coords.placeId,
    ...(coords.fetchedAt ? { coordsFetchedAt: coords.fetchedAt } : {}),
  };
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
