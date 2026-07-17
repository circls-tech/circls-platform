import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db, pingDb } from '../db/client.js';
import { bookings, tenants, users, venues } from '../db/schema/index.js';
import {
  createEvent,
  listEventBookings,
  listEventsForTenant,
  updateEvent,
} from './events_service.js';

const runIntegration = Boolean(process.env.RUN_INTEGRATION);

describe.skipIf(!runIntegration)('events_service — scoping', () => {
  let tenantId: string;
  let venueId: string;
  let actorUserId: string;
  const ctx = () => ({ tenantId, actorUserId });

  beforeAll(async () => {
    await pingDb();
    const [u] = await db
      .insert(users)
      .values({ firebaseUid: `evtsvc-${Date.now()}`, email: `evt-${Date.now()}@test.x` })
      .returning();
    actorUserId = u!.id;
    const [t] = await db
      .insert(tenants)
      .values({ name: 'EvtSvc', slug: `evtsvc-${Date.now()}` })
      .returning();
    tenantId = t!.id;
    const [v] = await db
      .insert(venues)
      .values({ tenantId, name: 'EvtSvc Venue', status: 'active' })
      .returning();
    venueId = v!.id;
  });

  afterAll(async () => {
    await db.execute(sql`delete from audit_log where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from bookings where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from users where firebase_uid like ${'evtsvc-reg-%'}`);
    await db.execute(sql`delete from events where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from venues where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
    await db.execute(sql`delete from users where id = ${actorUserId}`);
    await closeDb();
  });

  it('creates a venue-scoped event with null location columns', async () => {
    const ev = await createEvent(ctx(), {
      tenantId,
      venueId,
      name: 'Venue Event',
      startsAt: new Date('2030-01-01T10:00:00Z'),
      endsAt: new Date('2030-01-01T12:00:00Z'),
      tiers: [{ name: 'General', pricePaise: 0 }],
    });
    expect(ev.venueId).toBe(venueId);
    expect(ev.addressJson).toBeNull();
    expect(ev.tzName).toBeNull();
  });

  it('creates an org-scoped event with a standalone address + tz', async () => {
    const ev = await createEvent(ctx(), {
      tenantId,
      addressJson: { line1: '1 Park Rd', city: 'Pune' },
      lat: 18.52,
      lng: 73.85,
      tzName: 'Asia/Kolkata',
      name: 'Org Event',
      startsAt: new Date('2030-02-01T10:00:00Z'),
      endsAt: new Date('2030-02-01T12:00:00Z'),
      tiers: [{ name: 'General', pricePaise: 0 }],
    });
    expect(ev.venueId).toBeNull();
    expect(ev.tzName).toBe('Asia/Kolkata');
    expect((ev.addressJson as Record<string, unknown>).city).toBe('Pune');
  });

  it('derives coordinates from a standalone address when the caller omits lat/lng', async () => {
    // Stub geocoder (GEOCODER_PROVIDER default): Pune, India resolves from the
    // built-in gazetteer — no network. Mirrors the venue address flow.
    const ev = await createEvent(ctx(), {
      tenantId,
      addressJson: { line1: '2 Derive Rd', city: 'Pune', country: 'India' },
      tzName: 'Asia/Kolkata',
      name: 'Geocoded Event',
      startsAt: new Date('2030-02-02T10:00:00Z'),
      endsAt: new Date('2030-02-02T12:00:00Z'),
      tiers: [{ name: 'General', pricePaise: 0 }],
    });
    expect(ev.lat).toBeCloseTo(18.5204, 3);
    expect(ev.lng).toBeCloseTo(73.8567, 3);
  });

  it('keeps caller-provided coordinates instead of geocoding', async () => {
    const ev = await createEvent(ctx(), {
      tenantId,
      addressJson: { city: 'Pune', country: 'India' },
      lat: 1.23,
      lng: 4.56,
      tzName: 'Asia/Kolkata',
      name: 'Hand-set Coords Event',
      startsAt: new Date('2030-02-03T10:00:00Z'),
      endsAt: new Date('2030-02-03T12:00:00Z'),
      tiers: [{ name: 'General', pricePaise: 0 }],
    });
    expect(ev.lat).toBeCloseTo(1.23, 5);
    expect(ev.lng).toBeCloseTo(4.56, 5);
  });

  it('leaves coordinates null when the address cannot be geocoded', async () => {
    // No city/country → nothing to resolve; the save still succeeds.
    const ev = await createEvent(ctx(), {
      tenantId,
      addressJson: { line1: '99 Unknown Alley' },
      tzName: 'Asia/Kolkata',
      name: 'Ungeodable Event',
      startsAt: new Date('2030-02-04T10:00:00Z'),
      endsAt: new Date('2030-02-04T12:00:00Z'),
      tiers: [{ name: 'General', pricePaise: 0 }],
    });
    expect(ev.lat).toBeNull();
    expect(ev.lng).toBeNull();
  });

  it('re-derives coordinates when an update changes the address without lat/lng', async () => {
    const ev = await createEvent(ctx(), {
      tenantId,
      addressJson: { city: 'Pune', country: 'India' },
      tzName: 'Asia/Kolkata',
      name: 'Regeocode Event',
      startsAt: new Date('2030-02-05T10:00:00Z'),
      endsAt: new Date('2030-02-05T12:00:00Z'),
      tiers: [{ name: 'General', pricePaise: 0 }],
    });
    const moved = await updateEvent(ctx(), ev.id, {
      addressJson: { city: 'Mumbai', country: 'India' },
    });
    expect(moved.lat).toBeCloseTo(19.076, 3);
    expect(moved.lng).toBeCloseTo(72.8777, 3);
  });

  it('canonicalizes an alias city on create, and geocodes the canonical name', async () => {
    // "Bangalore" is an alias of "Bengaluru" in the gazetteer — the stored
    // address must use the canonical spelling so one city never splits into
    // several in the consumer city filter.
    const ev = await createEvent(ctx(), {
      tenantId,
      addressJson: { line1: '3 Alias Rd', city: 'Bangalore', country: 'India' },
      tzName: 'Asia/Kolkata',
      name: 'Alias City Event',
      startsAt: new Date('2030-02-06T10:00:00Z'),
      endsAt: new Date('2030-02-06T12:00:00Z'),
      tiers: [{ name: 'General', pricePaise: 0 }],
    });
    expect((ev.addressJson as Record<string, unknown>).city).toBe('Bengaluru');
    expect(ev.lat).toBeCloseTo(12.9716, 3);
  });

  it('canonicalizes the city on update, and keeps unknown cities as typed', async () => {
    const ev = await createEvent(ctx(), {
      tenantId,
      addressJson: { city: 'Pune', country: 'India' },
      tzName: 'Asia/Kolkata',
      name: 'Canon Update Event',
      startsAt: new Date('2030-02-07T10:00:00Z'),
      endsAt: new Date('2030-02-07T12:00:00Z'),
      tiers: [{ name: 'General', pricePaise: 0 }],
    });
    const aliased = await updateEvent(ctx(), ev.id, {
      addressJson: { city: 'bombay', country: 'India' },
    });
    expect((aliased.addressJson as Record<string, unknown>).city).toBe('Mumbai');
    // A misspelling the gazetteer doesn't know survives untouched (never destructive).
    const typo = await updateEvent(ctx(), ev.id, {
      addressJson: { city: 'Banagalore', country: 'India' },
    });
    expect((typo.addressJson as Record<string, unknown>).city).toBe('Banagalore');
  });

  it('rejects a standalone event missing an address', async () => {
    await expect(
      createEvent(ctx(), {
        tenantId,
        tzName: 'Asia/Kolkata',
        name: 'No Address',
        startsAt: new Date('2030-03-01T10:00:00Z'),
        endsAt: new Date('2030-03-01T12:00:00Z'),
        tiers: [{ name: 'General', pricePaise: 0 }],
      }),
    ).rejects.toThrow();
  });

  it('lists all events for the tenant (venue + standalone)', async () => {
    const rows = await listEventsForTenant(tenantId);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.some((r) => r.venueId === venueId)).toBe(true);
    expect(rows.some((r) => r.venueId === null)).toBe(true);
  });

  it('re-scopes a standalone event onto a venue and clears its address', async () => {
    const standalone = await createEvent(ctx(), {
      tenantId,
      addressJson: { line1: '5 Move Rd', city: 'Pune' },
      tzName: 'Asia/Kolkata',
      name: 'Movable Event',
      startsAt: new Date('2030-05-01T10:00:00Z'),
      endsAt: new Date('2030-05-01T12:00:00Z'),
      tiers: [{ name: 'General', pricePaise: 0 }],
    });
    expect(standalone.venueId).toBeNull();

    const moved = await updateEvent(ctx(), standalone.id, { venueId });
    expect(moved.venueId).toBe(venueId);
    expect(moved.addressJson).toBeNull();
    expect(moved.tzName).toBeNull();
  });

  it('rejects making a venue-scoped event standalone with no address', async () => {
    const venueScoped = await createEvent(ctx(), {
      tenantId,
      venueId,
      name: 'Stuck At Venue',
      startsAt: new Date('2030-06-01T10:00:00Z'),
      endsAt: new Date('2030-06-01T12:00:00Z'),
      tiers: [{ name: 'General', pricePaise: 0 }],
    });
    await expect(updateEvent(ctx(), venueScoped.id, { venueId: null })).rejects.toThrow();
  });

  it('re-scopes a venue-scoped event to standalone when an address is provided', async () => {
    const venueScoped = await createEvent(ctx(), {
      tenantId,
      venueId,
      name: 'Going Standalone',
      startsAt: new Date('2030-07-01T10:00:00Z'),
      endsAt: new Date('2030-07-01T12:00:00Z'),
      tiers: [{ name: 'General', pricePaise: 0 }],
    });
    const moved = await updateEvent(ctx(), venueScoped.id, {
      venueId: null,
      addressJson: { line1: '9 New St', city: 'Mumbai' },
      tzName: 'Asia/Kolkata',
    });
    expect(moved.venueId).toBeNull();
    expect(moved.addressJson).toMatchObject({ line1: '9 New St', city: 'Mumbai' });
    expect(moved.tzName).toBe('Asia/Kolkata');
  });

  it('lists event registrations with contact details, including cancelled ones', async () => {
    const ev = await createEvent(ctx(), {
      tenantId,
      venueId,
      name: 'Registrations Event',
      startsAt: new Date('2030-08-01T10:00:00Z'),
      endsAt: new Date('2030-08-01T12:00:00Z'),
      tiers: [{ name: 'General', pricePaise: 0 }],
    });

    const suffix = Date.now();
    const [linked] = await db
      .insert(users)
      .values({
        firebaseUid: `evtsvc-reg-${suffix}`,
        displayName: 'Linked User',
        email: `linked-${suffix}@test.x`,
        phoneE164: `+9198${String(suffix).slice(-8)}`,
      })
      .returning();
    const base = {
      tenantId,
      venueId,
      itemType: 'event' as const,
      channel: 'circls' as const,
      paymentMethod: 'free' as const,
      itemData: { eventId: ev.id },
      totalPaise: 0,
    };
    await db.insert(bookings).values([
      { ...base, status: 'confirmed', customerUserId: linked!.id },
      { ...base, status: 'confirmed', customerName: 'Email Walkin', customerContact: 'walkin@test.x' },
      { ...base, status: 'cancelled', customerName: 'Phone Cancel', customerContact: '+919812345678' },
    ]);

    const rows = await listEventBookings(tenantId, ev.id);
    expect(rows).toHaveLength(3);

    const linkedRow = rows.find((r) => r.customerName === 'Linked User');
    expect(linkedRow?.customerEmail).toBe(linked!.email);
    expect(linkedRow?.customerPhone).toBe(linked!.phoneE164);

    const emailRow = rows.find((r) => r.customerName === 'Email Walkin');
    expect(emailRow?.customerEmail).toBe('walkin@test.x');
    expect(emailRow?.customerPhone).toBeNull();

    const cancelledRow = rows.find((r) => r.customerName === 'Phone Cancel');
    expect(cancelledRow?.status).toBe('cancelled');
    expect(cancelledRow?.customerEmail).toBeNull();
    expect(cancelledRow?.customerPhone).toBe('+919812345678');
  });
});
