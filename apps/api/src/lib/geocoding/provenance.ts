/**
 * Where a listing's stored coordinates came from, as the two columns venues
 * and events record it in. Google's terms let us keep its coordinates for 30
 * days but its place IDs indefinitely, so coordinates from Google keep their
 * place ID and fetch time, and services/coords_refresh_service.ts re-fetches
 * them before they expire. The partner's own pin — and OpenStreetMap or
 * gazetteer coordinates, which are ours to keep — have neither.
 */
import { z } from 'zod';

/** A Google place ID as clients send it back (`ChIJ…`: URL-safe base64). */
export const placeIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,300}$/);

export interface CoordsProvenance {
  coordsPlaceId: string | null;
  coordsFetchedAt: Date | null;
}

/** Provenance for coordinates written just now: Google's when they came with
 *  a place ID, otherwise ours to keep. */
export function coordsProvenance(placeId: string | null | undefined, now: Date = new Date()): CoordsProvenance {
  return placeId
    ? { coordsPlaceId: placeId, coordsFetchedAt: now }
    : { coordsPlaceId: null, coordsFetchedAt: null };
}

/**
 * Provenance for coordinates a caller sent explicitly, or undefined to leave
 * the stored columns as they are.
 *
 * Coordinates equal to the stored ones are a form re-sending an untouched pin:
 * they keep the row's provenance, so saving again neither resets a Google fetch
 * time (which would hold its coordinates past the 30 days) nor passes Google
 * coordinates off as the partner's. Otherwise a place ID marks them as picked
 * from Google address search, and without one they are the partner's own pin.
 */
export function sentCoordsProvenance(
  sent: { lat: number | null; lng: number | null; coordsPlaceId?: string | null | undefined },
  stored?: { lat: number | null; lng: number | null } | null,
  now: Date = new Date(),
): CoordsProvenance | undefined {
  if (sent.lat == null || sent.lng == null) return coordsProvenance(null);
  if (stored && stored.lat === sent.lat && stored.lng === sent.lng) return undefined;
  return coordsProvenance(sent.coordsPlaceId, now);
}
