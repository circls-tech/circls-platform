import { and, asc, eq, isNotNull, lt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { events, venues } from '../db/schema/index.js';
import { findGazetteerCity } from '../lib/geocoding/gazetteer.js';
import { type GeocodeQuery, getGeocoder, hasGeocodableAddress } from '../lib/geocoding/index.js';
import { type CoordsProvenance, coordsProvenance } from '../lib/geocoding/provenance.js';
import { toGeocodeQuery } from './events_service.js';

/**
 * Keeps stored Google coordinates inside Google's 30-day caching limit.
 *
 * Google's terms let us keep coordinates from its Geocoding and Places APIs
 * for at most 30 consecutive days, but place IDs indefinitely (Maps Service
 * Specific Terms §6.3.1, §14.3). A venue or standalone event whose pin came
 * from Google therefore records the place and when it was fetched
 * (`coords_place_id`, `coords_fetched_at` — see lib/geocoding/provenance.ts).
 *
 * The worker runs this daily. Coordinates older than REFRESH_AFTER_DAYS are
 * re-fetched by place ID, which restarts their 30 days. A failed re-fetch is
 * retried the next day until DROP_AFTER_DAYS; then — or straight away for an
 * event that is over, whose pin no customer needs — the coordinates are
 * replaced with ones we may keep: the address geocoded afresh for a live
 * listing, else the gazetteer centre of its city, else none.
 */

export const REFRESH_AFTER_DAYS = 25;
export const DROP_AFTER_DAYS = 29;

/** Rows per table per run — far above the daily need, a cap on a bad day. */
const BATCH = 500;

const DAY_MS = 86_400_000;

interface DueRow {
  placeId: string;
  fetchedAt: Date;
  address: GeocodeQuery;
  ended: boolean;
}

type NextCoords = CoordsProvenance & { lat: number | null; lng: number | null };

/** What a due row's coordinates become, or null to leave them for tomorrow. */
async function nextCoords(row: DueRow, now: Date): Promise<NextCoords | null> {
  const geocoder = getGeocoder();
  if (!row.ended) {
    const fresh = await geocoder.resolve(row.placeId);
    if (fresh?.lat != null && fresh.lng != null) {
      return { lat: fresh.lat, lng: fresh.lng, ...coordsProvenance(fresh.placeId, now) };
    }
    if (now.getTime() - row.fetchedAt.getTime() < DROP_AFTER_DAYS * DAY_MS) return null;
    if (hasGeocodableAddress(row.address)) {
      const point = await geocoder.geocode(row.address);
      if (point) return { lat: point.lat, lng: point.lng, ...coordsProvenance(point.placeId, now) };
    }
  }
  const centre = findGazetteerCity(row.address.city, row.address.country);
  return { lat: centre?.lat ?? null, lng: centre?.lng ?? null, ...coordsProvenance(null) };
}

export async function refreshGoogleCoords(
  now: Date = new Date(),
): Promise<{ refreshed: number; replaced: number }> {
  const cutoff = new Date(now.getTime() - REFRESH_AFTER_DAYS * DAY_MS);
  const counts = { refreshed: 0, replaced: 0 };
  const tally = (next: NextCoords) => {
    if (next.coordsPlaceId) counts.refreshed++;
    else counts.replaced++;
  };

  const dueVenues = await db
    .select({
      id: venues.id,
      placeId: venues.coordsPlaceId,
      fetchedAt: venues.coordsFetchedAt,
      line1: venues.addressLine1,
      city: venues.city,
      state: venues.state,
      postalCode: venues.postalCode,
      country: venues.country,
    })
    .from(venues)
    .where(and(isNotNull(venues.coordsPlaceId), lt(venues.coordsFetchedAt, cutoff)))
    .orderBy(asc(venues.coordsFetchedAt))
    .limit(BATCH);
  for (const v of dueVenues) {
    if (!v.placeId || !v.fetchedAt) continue;
    const next = await nextCoords({ placeId: v.placeId, fetchedAt: v.fetchedAt, address: v, ended: false }, now);
    if (!next) continue;
    // Matching the place ID too means a pin the partner moved meanwhile wins.
    await db
      .update(venues)
      .set(next)
      .where(and(eq(venues.id, v.id), eq(venues.coordsPlaceId, v.placeId)));
    tally(next);
  }

  const dueEvents = await db
    .select({
      id: events.id,
      placeId: events.coordsPlaceId,
      fetchedAt: events.coordsFetchedAt,
      addressJson: events.addressJson,
      endsAt: events.endsAt,
    })
    .from(events)
    .where(and(isNotNull(events.coordsPlaceId), lt(events.coordsFetchedAt, cutoff)))
    .orderBy(asc(events.coordsFetchedAt))
    .limit(BATCH);
  for (const e of dueEvents) {
    if (!e.placeId || !e.fetchedAt) continue;
    const next = await nextCoords(
      {
        placeId: e.placeId,
        fetchedAt: e.fetchedAt,
        address: toGeocodeQuery(e.addressJson ?? {}),
        ended: e.endsAt != null && e.endsAt < now,
      },
      now,
    );
    if (!next) continue;
    await db
      .update(events)
      .set(next)
      .where(and(eq(events.id, e.id), eq(events.coordsPlaceId, e.placeId)));
    tally(next);
  }

  return counts;
}
