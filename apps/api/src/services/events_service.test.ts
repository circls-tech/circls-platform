import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db, pingDb } from '../db/client.js';
import { tenants, venues } from '../db/schema/index.js';
import { bookEvent } from './booking_service.js';
import {
  cancelEvent,
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
  let actorUserId: string;

  beforeAll(async () => {
    await pingDb();
    const [t] = await db
      .insert(tenants)
      .values({ name: 'EventsCo', slug: `evtco-${Date.now()}` })
      .returning();
    tenantId = t!.id;
    const usersTbl = (await import('../db/schema/users.js')).users;
    const [u] = await db
      .insert(usersTbl)
      .values({ firebaseUid: `evt-fb-${Date.now()}`, email: `evt-${Date.now()}@x.com` })
      .returning();
    actorUserId = u!.id;
    // Events are venue-scoped (no arenas) since subproject C.
    const [v] = await db
      .insert(venues)
      .values({ tenantId, name: 'Main Venue', tzName: 'Asia/Kolkata' })
      .returning();
    venueId = v!.id;
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
        },
      ),
    ).rejects.toMatchObject({ code: 'invalid_event_window' });
  });

  it('createEvent inserts a venue-scoped draft event', async () => {
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
      },
    );
    expect(ev.id).toBeTruthy();
    expect(ev.status).toBe('draft');
    expect(ev.pricePaise).toBe(50000);
    const back = await getEvent(ev.id, tenantId);
    expect(back?.id).toBe(ev.id);
  });

  it('publishEvent submits a draft for review (draft → pending_review)', async () => {
    const ev = await createEvent(
      { tenantId, actorUserId },
      {
        tenantId,
        venueId,
        name: 'PubMe',
        startsAt: new Date('2026-08-11T12:00:00Z'),
        endsAt: new Date('2026-08-11T14:00:00Z'),
        pricePaise: 0,
      },
    );
    const pub = await publishEvent({ tenantId, actorUserId }, ev.id);
    expect(pub.status).toBe('pending_review');
    await expect(
      publishEvent({ tenantId, actorUserId }, ev.id),
    ).rejects.toMatchObject({ code: 'event_not_draft' });
  });

  it('updateEvent on a non-draft event is rejected with event_not_draft', async () => {
    const ev = await createEvent(
      { tenantId, actorUserId },
      {
        tenantId,
        venueId,
        name: 'Frozen',
        startsAt: new Date('2026-08-12T12:00:00Z'),
        endsAt: new Date('2026-08-12T14:00:00Z'),
        pricePaise: 0,
      },
    );
    await publishEvent({ tenantId, actorUserId }, ev.id);
    await expect(
      updateEvent({ tenantId, actorUserId }, ev.id, { name: 'Renamed' }),
    ).rejects.toMatchObject({ code: 'event_not_draft' });
  });

  it('cancelEvent moves an event to cancelled; re-cancelling is a 409', async () => {
    const ev = await createEvent(
      { tenantId, actorUserId },
      {
        tenantId,
        venueId,
        name: 'Scrapped',
        startsAt: new Date('2026-08-20T12:00:00Z'),
        endsAt: new Date('2026-08-20T14:00:00Z'),
        pricePaise: 0,
      },
    );
    const cancelled = await cancelEvent({ tenantId, actorUserId }, ev.id);
    expect(cancelled.status).toBe('cancelled');
    await expect(
      cancelEvent({ tenantId, actorUserId }, ev.id),
    ).rejects.toMatchObject({ code: 'event_not_cancellable' });
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
      },
    );
    await publishEvent({ tenantId, actorUserId }, ev.id);
    await approveListing({ type: 'event', id: ev.id, actorUserId }); // pending_review → published

    const first = await bookEvent(ev.id, { userId: actorUserId, name: 'Alice' });
    expect(first.booking.status).toBe('confirmed');
    expect(first.booking.paymentMethod).toBe('free');

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
      },
    );
    await publishEvent({ tenantId, actorUserId }, ev.id);
    await approveListing({ type: 'event', id: ev.id, actorUserId }); // pending_review → published

    const ok = await bookEvent(ev.id, { userId: actorUserId, name: 'Payer' });
    expect(ok.booking.status).toBe('pending');
    expect(ok.paymentId).toBeDefined();
    expect(ok.providerOrderId).toBeDefined();
  });
});
