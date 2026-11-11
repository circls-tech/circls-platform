/**
 * Where a listing's stored coordinates came from, as the two columns venues
 * and events record it in. Google's terms let us keep its coordinates for 30
 * days but its place IDs indefinitely, so coordinates from Google keep their
 * place ID and fetch time, and services/coords_refresh_service.ts re-fetches
 * them before they expire. The partner's own pin — and OpenStreetMap or
 * gazetteer coordinates, which are ours to keep — have neither.
 */
import { z } from 'zod';

/**
 * A Google place ID as clients send it back: URL-safe base64. Google sets no
 * maximum length — a business is a 27-character `ChIJ…`, but a street address
 * is an `Ek…`/`Ei…` ID of 170+ — so the cap only stops abuse, it is not a
 * guess at the longest real ID.
 */
export const placeIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,1024}$/);

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
 *
 * `coordsFetchedAt` is when Google returned them, if the caller knows — a
 * draft saved later, or a duplicated event, would otherwise restart their 30
 * days. It can only make the clock earlier: a future time counts as now.
 */
export function sentCoordsProvenance(
  sent: {
    lat: number | null;
    lng: number | null;
    coordsPlaceId?: string | null | undefined;
    coordsFetchedAt?: Date | null | undefined;
  },
  stored?: { lat: number | null; lng: number | null } | null,
  now: Date = new Date(),
): CoordsProvenance | undefined {
  if (sent.lat == null || sent.lng == null) return coordsProvenance(null);
  if (stored && stored.lat === sent.lat && stored.lng === sent.lng) return undefined;
  const fetched = sent.coordsFetchedAt && sent.coordsFetchedAt < now ? sent.coordsFetchedAt : now;
  return coordsProvenance(sent.coordsPlaceId, fetched);
}

/**
 * A row or patch as the audit log may keep it: without Google's coordinates,
 * which may only be kept 30 days while the audit log keeps everything. The
 * place ID stays (it may be kept indefinitely), so the entry still says where.
 * `placeId` is the place the coordinates belong to when the object itself
 * doesn't carry it — a patch re-sending an unmoved Google pin, say.
 */
export function withoutGoogleCoords<T extends Record<string, unknown>>(
  row: T,
  placeId?: string | null,
): T {
  // The object's own place wins, even a null one (a pin just made the partner's).
  const google = 'coordsPlaceId' in row ? (row.coordsPlaceId as string | null | undefined) : placeId;
  if (!google || (!('lat' in row) && !('lng' in row))) return row;
  const { lat: _lat, lng: _lng, ...rest } = row;
  return rest as T;
}
