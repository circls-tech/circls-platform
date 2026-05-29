import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db, pingDb } from '../db/client.js';
import { arenas, tenants, venues } from '../db/schema/index.js';
import { eq } from 'drizzle-orm';
import { bookEvent } from './booking_service.js';
import {
  createEvent,
  getEvent,
  publishEvent,
  updateEvent,
} from './events_service.js';
import { approveListing } from './listing_service.js';

const runIntegration = Boolean(process.env.RUN_INTEGRATION);

describe.skipIf(!runIntegration)('events_service', () => {
  let tenantId: string;
  let venueId: string;
  let venue2Id: string;
  let arenaA: string;
  let arenaB: string;
  let arenaOtherVenue: string;
  let actorUserId: string;

  beforeAll(async () => {
    await pingDb();
    const [t] = await db
      .insert(tenants)
      .values({ name: 'EventsCo', slug: `evtco-${Date.now()}` })
      .returning();
    tenantId = t!.id;
    // A throwaway user row to satisfy created_by_user_id FKs via the booking layer.
    const usersTbl = (await import('../db/schema/users.js')).users;
    const [u] = await db
      .insert(usersTbl)
      .values({
        firebaseUid: `evt-fb-${Date.now()}`,
        email: `evt-${Date.now()}@x.com`,
      })
      .returning();
    actorUserId = u!.id;
    const [v] = await db
      .insert(venues)
      .values({ tenantId, name: 'Main Venue', tzName: 'Asia/Kolkata' })
      .returning();
    venueId = v!.id;
    const [v2] = await db
      .insert(venues)
      .values({ tenantId, name: 'Second Venue', tzName: 'Asia/Kolkata' })
      .returning();
    venue2Id = v2!.id;
    const [a1] = await db.insert(arenas).values({ venueId, name: 'Arena A' }).returning();
    const [a2] = await db.insert(arenas).values({ venueId, name: 'Arena B' }).returning();
    const [a3] = await db.insert(arenas).values({ venueId: venue2Id, name: 'Other' }).returning();
    arenaA = a1!.id;
    arenaB = a2!.id;
    arenaOtherVenue = a3!.id;
  });

  afterAll(async () => {
    await closeDb();
  });

  it('createEvent rejects when startsAt >= endsAt', async () => {
    await expect(
      createEvent(
        { tenantId, actorUserId },
        {
          tenantId,
          venueId,
          name: 'Bad Window',
          startsAt: new Date('2026-08-01T12:00:00Z'),
          endsAt: new Date('2026-08-01T12:00:00Z'),
          pricePaise: 0,
          arenaIds: [arenaA],
        },
      ),
    ).rejects.toMatchObject({ code: 'invalid_event_window' });
  });

  it('createEvent rejects an arena from a different venue', async () => {
    await expect(
      createEvent(
        { tenantId, actorUserId },
        {
          tenantId,
          venueId,
          name: 'Cross Venue',
          startsAt: new Date('2026-08-01T12:00:00Z'),
          endsAt: new Date('2026-08-01T14:00:00Z'),
          pricePaise: 0,
          arenaIds: [arenaA, arenaOtherVenue],
        },
      ),
    ).rejects.toMatchObject({ code: 'arena_venue_mismatch' });
  });

  it('createEvent inserts an event + event_arenas in one transaction', async () => {
    const ev = await createEvent(
      { tenantId, actorUserId },
      {
        tenantId,
        venueId,
        name: 'Tournament',
        description: 'Knockout',
        startsAt: new Date('2026-08-10T12:00:00Z'),
        endsAt: new Date('2026-08-10T18:00:00Z'),
        pricePaise: 50000,
        capacity: 2,
        arenaIds: [arenaA, arenaB],
      },
    );
    expect(ev.id).toBeTruthy();
    expect(ev.status).toBe('draft');
    expect(ev.pricePaise).toBe(50000);
    const back = await getEvent(ev.id, tenantId);
    expect(back?.id).toBe(ev.id);
  });

  it('publishEvent only works on draft events with arenas', async () => {
    const ev = await createEvent(
      { tenantId, actorUserId },
      {
        tenantId,
        venueId,
        name: 'PubMe',
        startsAt: new Date('2026-08-11T12:00:00Z'),
        endsAt: new Date('2026-08-11T14:00:00Z'),
        pricePaise: 0,
        arenaIds: [arenaA],
      },
    );
    // Publish now submits for review: draft → pending_review.
    const pub = await publishEvent({ tenantId, actorUserId }, ev.id);
    expect(pub.status).toBe('pending_review');
    // Re-submitting a non-draft event is a 409.
    await expect(
      publishEvent({ tenantId, actorUserId }, ev.id),
    ).rejects.toMatchObject({ code: 'event_not_draft' });
  });

  it('updateEvent on a published event is rejected with event_not_draft', async () => {
    const ev = await createEvent(
      { tenantId, actorUserId },
      {
        tenantId,
        venueId,
        name: 'Frozen',
        startsAt: new Date('2026-08-12T12:00:00Z'),
        endsAt: new Date('2026-08-12T14:00:00Z'),
        pricePaise: 0,
        arenaIds: [arenaA],
      },
    );
    await publishEvent({ tenantId, actorUserId }, ev.id);
    await expect(
      updateEvent({ tenantId, actorUserId }, ev.id, { name: 'Renamed' }),
    ).rejects.toMatchObject({ code: 'event_not_draft' });
  });

  it('bookEvent (free) creates a confirmed booking; capacity rejects the next attempt', async () => {
    const ev = await createEvent(
      { tenantId, actorUserId },
      {
        tenantId,
        venueId,
        name: 'Free Yoga',
        startsAt: new Date('2026-09-01T12:00:00Z'),
        endsAt: new Date('2026-09-01T13:00:00Z'),
        pricePaise: 0,
        capacity: 1,
        arenaIds: [arenaA],
      },
    );
    await publishEvent({ tenantId, actorUserId }, ev.id);
    await approveListing({ type: 'event', id: ev.id, actorUserId }); // pending_review → published

    const first = await bookEvent(ev.id, { userId: actorUserId, name: 'Alice' });
    expect(first.booking.status).toBe('confirmed');
    expect(first.booking.paymentMethod).toBe('free');

    // Second seat would exceed capacity=1.
    await expect(
      bookEvent(ev.id, { userId: actorUserId, name: 'Bob' }),
    ).rejects.toMatchObject({ code: 'event_full' });
  });

  it('bookEvent rejects unpublished events', async () => {
    const ev = await createEvent(
      { tenantId, actorUserId },
      {
        tenantId,
        venueId,
        name: 'Draft Only',
        startsAt: new Date('2026-09-10T12:00:00Z'),
        endsAt: new Date('2026-09-10T13:00:00Z'),
        pricePaise: 0,
        arenaIds: [arenaA],
      },
    );
    await expect(
      bookEvent(ev.id, { userId: actorUserId, name: 'Z' }),
    ).rejects.toMatchObject({ code: 'event_not_published' });
  });

  it('bookEvent (paid) creates a pending booking + order — Circls is merchant', async () => {
    const ev = await createEvent(
      { tenantId, actorUserId },
      {
        tenantId,
        venueId,
        name: 'Paid Match',
        startsAt: new Date('2026-09-15T12:00:00Z'),
        endsAt: new Date('2026-09-15T14:00:00Z'),
        pricePaise: 100000,
        arenaIds: [arenaA],
      },
    );
    await publishEvent({ tenantId, actorUserId }, ev.id);
    await approveListing({ type: 'event', id: ev.id, actorUserId }); // pending_review → published

    // No KYC / Linked Account gate — the payment lands in Circls's account and
    // the stub Razorpay adapter mints an order directly.
    const ok = await bookEvent(ev.id, { userId: actorUserId, name: 'Payer' });
    expect(ok.booking.status).toBe('pending');
    expect(ok.paymentId).toBeDefined();
    expect(ok.providerOrderId).toBeDefined();
  });
});

