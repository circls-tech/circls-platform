/**
 * What the admin review panel is shown for one listing.
 *
 * Separate from listing_service.test.ts because that file closes the shared
 * connection pool in its afterAll, and these need a live one.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db, pingDb } from '../db/client.js';
import {
  eventTicketTiers,
  events,
  membershipTiers,
  memberships,
  tenants,
  venues,
} from '../db/schema/index.js';
import { getListingDetail } from './listing_service.js';

const runIntegration = Boolean(process.env.RUN_INTEGRATION);

/**
 * What the reviewer is shown.
 *
 * A reviewer approves or rejects on the strength of this payload, so a field
 * that silently reads the wrong column is worse than a missing one: it looks
 * like an answer. `events.capacity` was exactly that — never written since
 * capacity moved to the tiers, and rendered as "Unlimited" on every event.
 */
describe.skipIf(!runIntegration)('listing detail — what the partner entered', () => {
  let tenantId: string;

  beforeAll(async () => {
    await pingDb();
    const [t] = await db
      .insert(tenants)
      .values({ name: 'DetailSvc', slug: `detailsvc-${Date.now()}` })
      .returning();
    tenantId = t!.id;
  });

  afterAll(async () => {
    await db.execute(sql`delete from event_ticket_tiers where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from membership_tiers where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from events where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from memberships where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from venues where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
    await closeDb();
  });

  async function eventWithTiers(
    name: string,
    tiers: { name: string; pricePaise: number; capacity: number | null }[],
  ): Promise<string> {
    const [e] = await db
      .insert(events)
      .values({
        tenantId,
        name,
        startsAt: new Date('2030-01-01T10:00:00Z'),
        endsAt: new Date('2030-01-01T12:00:00Z'),
        addressJson: { line1: '1 Test Rd' },
        tzName: 'Asia/Kolkata',
        status: 'pending_review',
      })
      .returning();
    const id = e!.id;
    // Drizzle rejects an empty values(), and "no tiers" is a case worth testing.
    if (tiers.length > 0) {
      await db.insert(eventTicketTiers).values(
        tiers.map((t, i) => ({ eventId: id, tenantId, sortOrder: i, ...t })),
      );
    }
    return id;
  }

  it('reports capacity from the tiers, not the column that is never written', async () => {
    const id = await eventWithTiers('Capped Event', [
      { name: 'GA', pricePaise: 50000, capacity: 80 },
      { name: 'VIP', pricePaise: 150000, capacity: 20 },
    ]);
    const d = await getListingDetail('event', id);
    expect(d?.capacity).toBe(100);
  });

  it('treats one uncapped tier as making the whole listing uncapped', async () => {
    // Summing only the capped tiers would report a ceiling that does not exist.
    const id = await eventWithTiers('Partly Uncapped', [
      { name: 'GA', pricePaise: 50000, capacity: null },
      { name: 'VIP', pricePaise: 150000, capacity: 20 },
    ]);
    const d = await getListingDetail('event', id);
    expect(d?.capacity).toBeNull();
  });

  it('returns the price as a range, not just the cheapest tier', async () => {
    const id = await eventWithTiers('Ranged', [
      { name: 'GA', pricePaise: 50000, capacity: 10 },
      { name: 'VIP', pricePaise: 150000, capacity: 5 },
    ]);
    const d = await getListingDetail('event', id);
    expect(d?.priceMinPaise).toBe(50000);
    expect(d?.priceMaxPaise).toBe(150000);
  });

  it('returns the tiers themselves, in the order the partner arranged them', async () => {
    const id = await eventWithTiers('Ordered', [
      { name: 'Early bird', pricePaise: 30000, capacity: 10 },
      { name: 'Standard', pricePaise: 50000, capacity: null },
    ]);
    const d = await getListingDetail('event', id);
    expect(d?.tiers?.map((t) => t.name)).toEqual(['Early bird', 'Standard']);
    expect(d?.tiers?.[1]?.capacity).toBeNull();
  });

  it('reports no capacity for an event with no tiers, rather than a false zero', async () => {
    const id = await eventWithTiers('Empty', []);
    const d = await getListingDetail('event', id);
    expect(d?.capacity).toBeNull();
    expect(d?.tiers).toEqual([]);
  });

  it('carries a membership plan s tiers, with their own durations', async () => {
    const [m] = await db
      .insert(memberships)
      .values({ tenantId, name: 'Plan', pricePaise: 0, durationDays: 30, status: 'pending_review' })
      .returning();
    await db.insert(membershipTiers).values([
      { membershipId: m!.id, tenantId, name: 'Monthly', pricePaise: 100000, durationDays: 30, capacity: 50, sortOrder: 0 },
      { membershipId: m!.id, tenantId, name: 'Annual', pricePaise: 900000, durationDays: 365, capacity: 10, sortOrder: 1 },
    ]);

    const d = await getListingDetail('membership', m!.id);
    expect(d?.capacity).toBe(60);
    expect(d?.priceMinPaise).toBe(100000);
    expect(d?.priceMaxPaise).toBe(900000);
    expect(d?.tiers?.[1]?.durationDays).toBe(365);
  });

  it('shows the venue profile a partner filled in, not just its address', async () => {
    const [v] = await db
      .insert(venues)
      .values({
        tenantId,
        name: 'Full Venue',
        status: 'pending_review',
        description: 'A nice place',
        amenities: ['Parking', 'Showers'],
        contactPhone: '+911234567890',
        contactEmail: 'venue@test.x',
        city: 'Bengaluru',
        state: 'Karnataka',
        country: 'IN',
      })
      .returning();

    const d = await getListingDetail('venue', v!.id);
    // Each of these is editable in the portal and was absent from review.
    expect(d?.venueDescription).toBe('A nice place');
    expect(d?.amenities).toEqual(['Parking', 'Showers']);
    expect(d?.contactPhone).toBe('+911234567890');
    expect(d?.contactEmail).toBe('venue@test.x');
    expect(d?.city).toBe('Bengaluru');
  });
});
