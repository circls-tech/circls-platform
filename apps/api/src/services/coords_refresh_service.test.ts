import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const { closeDb, db, pingDb } = await import('../db/client.js');
const { events, tenants, venues } = await import('../db/schema/index.js');
const { eq } = await import('drizzle-orm');
const { getGeocoder } = await import('../lib/geocoding/index.js');
const { lookupGazetteer } = await import('../lib/geocoding/gazetteer.js');
const { createVenue, updateVenue } = await import('./venue_service.js');
const { refreshGoogleCoords } = await import('./coords_refresh_service.js');

const runIntegration = Boolean(process.env.RUN_INTEGRATION);

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date();
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

/*
 * The refresh is global — it acts on every tenant's rows. Safe because API
 * test files run one at a time, and every assertion reads back this file's own
 * rows. The geocoder is the sandbox stub, with resolve() stubbed per test.
 */
describe.skipIf(!runIntegration)('Google coordinates provenance + refresh', () => {
  let tenantId: string;

  beforeAll(async () => {
    await pingDb();
    const [t] = await db
      .insert(tenants)
      .values({ name: 'Coords Co', slug: `coordsco-${Date.now()}` })
      .returning();
    tenantId = t!.id;
  });

  afterEach(() => vi.restoreAllMocks());

  afterAll(async () => {
    await closeDb();
  });

  async function venueRow(id: string) {
    const [v] = await db.select().from(venues).where(eq(venues.id, id));
    return v!;
  }

  async function googleVenue(fetchedDaysAgo: number) {
    const [v] = await db
      .insert(venues)
      .values({
        tenantId,
        name: 'Google-pinned',
        tzName: 'Asia/Kolkata',
        city: 'Pune',
        country: 'India',
        lat: 18.5,
        lng: 73.8,
        coordsPlaceId: 'ChIJold',
        coordsFetchedAt: ago(fetchedDaysAgo),
      })
      .returning();
    return v!.id;
  }

  describe('writes', () => {
    it("records a picked Google place, keeps it on an untouched re-save, and drops it when the pin moves", async () => {
      const v = await createVenue(tenantId, { name: 'Picked', lat: 12.93, lng: 77.62, coordsPlaceId: 'ChIJpicked' });
      expect(v.coordsPlaceId).toBe('ChIJpicked');
      const fetchedAt = v.coordsFetchedAt!;
      expect(Math.abs(fetchedAt.getTime() - Date.now())).toBeLessThan(60_000);

      // The form re-sends the same pin with no place ID: still Google's, same clock.
      await updateVenue(tenantId, v.id, { lat: 12.93, lng: 77.62 });
      expect(await venueRow(v.id)).toMatchObject({ coordsPlaceId: 'ChIJpicked', coordsFetchedAt: fetchedAt });

      // The partner drags the pin: their own now.
      await updateVenue(tenantId, v.id, { lat: 12.94, lng: 77.62 });
      expect(await venueRow(v.id)).toMatchObject({ coordsPlaceId: null, coordsFetchedAt: null });
    });

    it("treats a pin set without a place as the partner's own", async () => {
      const v = await createVenue(tenantId, { name: 'Dropped pin', lat: 19.07, lng: 72.87 });
      expect(v).toMatchObject({ coordsPlaceId: null, coordsFetchedAt: null });
    });
  });

  describe('refreshGoogleCoords', () => {
    it('re-fetches coordinates past the refresh age by place ID, restarting their clock', async () => {
      const id = await googleVenue(26);
      const resolve = vi.spyOn(getGeocoder(), 'resolve').mockImplementation(async (placeId) =>
        placeId === 'ChIJold'
          ? { label: 'x', placeId: 'ChIJnew', line1: null, city: 'Pune', state: null, postalCode: null, country: 'India', lat: 18.52, lng: 73.85 }
          : null,
      );
      await refreshGoogleCoords(NOW);
      expect(resolve).toHaveBeenCalledWith('ChIJold');
      expect(await venueRow(id)).toMatchObject({
        lat: 18.52,
        lng: 73.85,
        coordsPlaceId: 'ChIJnew',
        coordsFetchedAt: NOW,
      });
    });

    it('leaves recent coordinates alone, and retries a failed re-fetch before the deadline', async () => {
      const fresh = await googleVenue(5);
      const failing = await googleVenue(26);
      vi.spyOn(getGeocoder(), 'resolve').mockResolvedValue(null);
      await refreshGoogleCoords(NOW);
      expect(await venueRow(fresh)).toMatchObject({ lat: 18.5, coordsPlaceId: 'ChIJold' });
      expect(await venueRow(failing)).toMatchObject({ lat: 18.5, coordsPlaceId: 'ChIJold' });
    });

    it('at the deadline, replaces coordinates it cannot re-fetch with ones we may keep', async () => {
      const id = await googleVenue(29.5);
      vi.spyOn(getGeocoder(), 'resolve').mockResolvedValue(null);
      await refreshGoogleCoords(NOW);
      // The stub geocodes the address to the gazetteer's Pune: ours, no place.
      const pune = lookupGazetteer('Pune', 'India')!;
      expect(await venueRow(id)).toMatchObject({
        lat: pune.lat,
        lng: pune.lng,
        coordsPlaceId: null,
        coordsFetchedAt: null,
      });
    });

    it("drops an ended event's Google pin for its city centre without asking Google", async () => {
      const [e] = await db
        .insert(events)
        .values({
          tenantId,
          venueId: null,
          addressJson: { line1: '1 Old St', city: 'Bangalore', country: 'India' },
          tzName: 'Asia/Kolkata',
          name: 'Over',
          startsAt: ago(41),
          endsAt: ago(40),
          pricePaise: 0,
          status: 'completed',
          lat: 12.95,
          lng: 77.6,
          coordsPlaceId: 'ChIJevent',
          coordsFetchedAt: ago(26),
        })
        .returning();
      const resolve = vi.spyOn(getGeocoder(), 'resolve');
      await refreshGoogleCoords(NOW);
      expect(resolve).not.toHaveBeenCalledWith('ChIJevent');
      const [row] = await db.select().from(events).where(eq(events.id, e!.id));
      const bengaluru = lookupGazetteer('Bengaluru', 'India')!;
      expect(row).toMatchObject({ lat: bengaluru.lat, lng: bengaluru.lng, coordsPlaceId: null });
    });
  });
});
