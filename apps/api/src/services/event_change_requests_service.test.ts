import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db, pingDb } from '../db/client.js';
import {
  bookings,
  eventBookingTickets,
  events,
  tenants,
  users,
  venues,
} from '../db/schema/index.js';
import { createEvent, updateEvent } from './events_service.js';
import { listTiers } from './event_tiers_service.js';
import {
  approveChangeRequest,
  createChangeRequest,
  getChangeRequestDetail,
  listChangeRequests,
  listChangeRequestsForReview,
  rejectChangeRequest,
  withdrawChangeRequest,
} from './event_change_requests_service.js';

const runIntegration = Boolean(process.env.RUN_INTEGRATION);

describe.skipIf(!runIntegration)('event_change_requests_service', () => {
  let tenantId: string;
  let venueId: string;
  let actorUserId: string;
  const ctx = () => ({ tenantId, actorUserId });
  let evSeq = 0;

  /** A published event with one capped paid tier, ready for change requests. */
  async function makePublishedEvent(
    tiers: { name: string; pricePaise: number; capacity?: number | null }[] = [
      { name: 'General', pricePaise: 10000, capacity: 50 },
    ],
  ) {
    evSeq += 1;
    const ev = await createEvent(ctx(), {
      tenantId,
      venueId,
      name: `CR Event ${evSeq}`,
      startsAt: new Date('2031-01-01T10:00:00Z'),
      endsAt: new Date('2031-01-01T12:00:00Z'),
      tiers,
    });
    await db.update(events).set({ status: 'published' }).where(eq(events.id, ev.id));
    const tierRows = await listTiers(db, ev.id);
    return { ev, tiers: tierRows };
  }

  /** A confirmed booking of `quantity` tickets on one tier. */
  async function bookTier(eventId: string, tierId: string, quantity: number) {
    const [b] = await db
      .insert(bookings)
      .values({
        tenantId,
        venueId,
        itemType: 'event',
        channel: 'circls',
        paymentMethod: 'free',
        itemData: { eventId },
        totalPaise: 0,
        status: 'confirmed',
        customerName: 'CR Buyer',
      })
      .returning();
    await db
      .insert(eventBookingTickets)
      .values({ bookingId: b!.id, tierId, quantity, unitPricePaise: 0 });
  }

  beforeAll(async () => {
    await pingDb();
    const [u] = await db
      .insert(users)
      .values({ firebaseUid: `evtcr-${Date.now()}`, email: `evtcr-${Date.now()}@test.x` })
      .returning();
    actorUserId = u!.id;
    const [t] = await db
      .insert(tenants)
      .values({ name: 'EvtCR', slug: `evtcr-${Date.now()}` })
      .returning();
    tenantId = t!.id;
    const [v] = await db
      .insert(venues)
      .values({ tenantId, name: 'EvtCR Venue', status: 'active' })
      .returning();
    venueId = v!.id;
  });

  afterAll(async () => {
    await db.execute(sql`delete from audit_log where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from bookings where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from events where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from venues where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
    await db.execute(sql`delete from users where id = ${actorUserId}`);
    await closeDb();
  });

  it('rejects change requests on a draft event', async () => {
    const draft = await createEvent(ctx(), {
      tenantId,
      venueId,
      name: 'Draft Event',
      startsAt: new Date('2031-01-01T10:00:00Z'),
      endsAt: new Date('2031-01-01T12:00:00Z'),
      tiers: [{ name: 'General', pricePaise: 0 }],
    });
    await expect(
      createChangeRequest(ctx(), draft.id, { name: 'New Name' }),
    ).rejects.toMatchObject({ code: 'event_not_published' });
  });

  it('rejects an empty patch', async () => {
    const { ev } = await makePublishedEvent();
    await expect(createChangeRequest(ctx(), ev.id, {})).rejects.toMatchObject({
      code: 'bad_request',
    });
  });

  it('creates a pending request with a snapshot, and enforces one-pending', async () => {
    const { ev } = await makePublishedEvent();
    const row = await createChangeRequest(ctx(), ev.id, { name: 'Renamed Live' });
    expect(row.status).toBe('pending');
    expect(row.snapshot.name).toBe(ev.name);

    await expect(
      createChangeRequest(ctx(), ev.id, { name: 'Second Attempt' }),
    ).rejects.toMatchObject({ code: 'change_request_pending' });

    // Withdrawing through another event's scope is a 404, not a withdraw.
    const { ev: other } = await makePublishedEvent();
    await expect(withdrawChangeRequest(ctx(), other.id, row.id)).rejects.toMatchObject({
      code: 'change_request_not_found',
    });

    // Withdraw frees the slot; withdrawing again conflicts.
    const withdrawn = await withdrawChangeRequest(ctx(), ev.id, row.id);
    expect(withdrawn.status).toBe('withdrawn');
    await expect(withdrawChangeRequest(ctx(), ev.id, row.id)).rejects.toMatchObject({
      code: 'change_request_not_pending',
    });
    const again = await createChangeRequest(ctx(), ev.id, { name: 'Third Attempt' });
    expect(again.status).toBe('pending');

    const rows = await listChangeRequests(tenantId, ev.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.id).toBe(again.id);
  });

  it('validates the window at submit time', async () => {
    const { ev } = await makePublishedEvent();
    await expect(
      createChangeRequest(ctx(), ev.id, {
        startsAt: '2031-01-01T14:00:00Z',
        endsAt: '2031-01-01T13:00:00Z',
      }),
    ).rejects.toMatchObject({ code: 'invalid_event_window' });
  });

  it('rejects capacity below sold at submit time', async () => {
    const { ev, tiers } = await makePublishedEvent([
      { name: 'General', pricePaise: 10000, capacity: 50 },
    ]);
    await bookTier(ev.id, tiers[0]!.id, 5);
    await expect(
      createChangeRequest(ctx(), ev.id, {
        tiers: [{ id: tiers[0]!.id, name: 'General', pricePaise: 10000, capacity: 3 }],
      }),
    ).rejects.toMatchObject({ code: 'tier_capacity_below_sold' });
  });

  it('approve applies name + window and marks the request approved', async () => {
    const { ev } = await makePublishedEvent();
    const row = await createChangeRequest(ctx(), ev.id, {
      name: 'Approved Name',
      startsAt: '2031-02-01T10:00:00Z',
      endsAt: '2031-02-01T12:00:00Z',
    });
    const res = await approveChangeRequest({ id: row.id, actorUserId });
    expect(res.status).toBe('approved');

    const [updated] = await db.select().from(events).where(eq(events.id, ev.id)).limit(1);
    expect(updated!.name).toBe('Approved Name');
    expect(updated!.startsAt.toISOString()).toBe('2031-02-01T10:00:00.000Z');
    expect(updated!.status).toBe('published');

    // Approve/reject on a settled request conflicts.
    await expect(approveChangeRequest({ id: row.id, actorUserId })).rejects.toMatchObject({
      code: 'change_request_not_pending',
    });
    await expect(rejectChangeRequest({ id: row.id, actorUserId })).rejects.toMatchObject({
      code: 'change_request_not_pending',
    });
  });

  it('approve applies tier edits in place — sold counts survive a rename', async () => {
    const { ev, tiers } = await makePublishedEvent([
      { name: 'Early Bird', pricePaise: 5000, capacity: 10 },
      { name: 'Unsold', pricePaise: 20000, capacity: 5 },
    ]);
    const early = tiers.find((t) => t.name === 'Early Bird')!;
    await bookTier(ev.id, early.id, 4);

    const row = await createChangeRequest(ctx(), ev.id, {
      tiers: [
        // Rename + reprice + shrink capacity (still >= sold) by id.
        { id: early.id, name: 'Regular', pricePaise: 7500, capacity: 4 },
        // New tier, no id.
        { name: 'VIP', pricePaise: 50000, capacity: 2 },
        // 'Unsold' omitted → removal (nothing sold, so allowed).
      ],
    });
    await approveChangeRequest({ id: row.id, actorUserId });

    const after = await listTiers(db, ev.id);
    expect(after).toHaveLength(2);
    const regular = after.find((t) => t.name === 'Regular')!;
    expect(regular.id).toBe(early.id); // id preserved — sold tickets stay attached
    expect(regular.pricePaise).toBe(7500);
    expect(regular.capacity).toBe(4);
    expect(after.some((t) => t.name === 'VIP')).toBe(true);
    expect(after.some((t) => t.name === 'Unsold')).toBe(false);

    const [updated] = await db.select().from(events).where(eq(events.id, ev.id)).limit(1);
    expect(updated!.pricePaise).toBe(7500); // min of the resulting set
  });

  it('approve fails and the request stays pending when a removed tier has sold since', async () => {
    const { ev, tiers } = await makePublishedEvent([
      { name: 'Keep', pricePaise: 1000, capacity: 20 },
      { name: 'Drop', pricePaise: 2000, capacity: 20 },
    ]);
    const drop = tiers.find((t) => t.name === 'Drop')!;
    const keep = tiers.find((t) => t.name === 'Keep')!;
    // Unsold at submit time, so the request is accepted…
    const row = await createChangeRequest(ctx(), ev.id, {
      tiers: [{ id: keep.id, name: 'Keep', pricePaise: 1000, capacity: 20 }],
    });
    // …then someone books the tier before the admin approves.
    await bookTier(ev.id, drop.id, 1);

    await expect(approveChangeRequest({ id: row.id, actorUserId })).rejects.toMatchObject({
      code: 'tier_has_bookings',
    });
    // Transaction rolled back: the request is still pending and the tier lives.
    const rows = await listChangeRequests(tenantId, ev.id);
    expect(rows[0]!.status).toBe('pending');
    const after = await listTiers(db, ev.id);
    expect(after.some((t) => t.name === 'Drop')).toBe(true);
  });

  it('approve fails and the request stays pending when the event was cancelled', async () => {
    const { ev } = await makePublishedEvent();
    const row = await createChangeRequest(ctx(), ev.id, { name: 'Too Late' });
    await db.update(events).set({ status: 'cancelled' }).where(eq(events.id, ev.id));

    await expect(approveChangeRequest({ id: row.id, actorUserId })).rejects.toMatchObject({
      code: 'event_not_published',
    });
    const rows = await listChangeRequests(tenantId, ev.id);
    expect(rows[0]!.status).toBe('pending');
  });

  it('reject records the reason the partner sees', async () => {
    const { ev } = await makePublishedEvent();
    const row = await createChangeRequest(ctx(), ev.id, { name: 'Rejected Name' });
    const res = await rejectChangeRequest({ id: row.id, actorUserId, reason: 'Date clash' });
    expect(res.status).toBe('rejected');
    const rows = await listChangeRequests(tenantId, ev.id);
    expect(rows[0]!.status).toBe('rejected');
    expect(rows[0]!.reason).toBe('Date clash');

    const [unchanged] = await db.select().from(events).where(eq(events.id, ev.id)).limit(1);
    expect(unchanged!.name).not.toBe('Rejected Name');
  });

  it('admin queue lists pending requests with field names; detail carries current values', async () => {
    const { ev, tiers } = await makePublishedEvent();
    const row = await createChangeRequest(ctx(), ev.id, {
      name: 'Queued Name',
      tiers: [{ id: tiers[0]!.id, name: 'General', pricePaise: 12000, capacity: 50 }],
    });

    const queue = await listChangeRequestsForReview();
    const mine = queue.find((q) => q.id === row.id);
    expect(mine).toBeDefined();
    expect(mine!.eventName).toBe(ev.name);
    expect(mine!.fields).toEqual(['name', 'tiers']);

    const detail = await getChangeRequestDetail(row.id);
    expect(detail).not.toBeNull();
    expect(detail!.event.name).toBe(ev.name); // current, not proposed
    expect(detail!.patch.name).toBe('Queued Name');
    expect(detail!.snapshot.tiers).toHaveLength(1);
    expect(detail!.event.tiers[0]!.sold).toBe(0);
    expect(detail!.event.venueName).toBe('EvtCR Venue');

    await withdrawChangeRequest(ctx(), ev.id, row.id); // leave no pending rows behind
  });

  it('published events still accept the free live settings directly', async () => {
    const { ev } = await makePublishedEvent();
    const updated = await updateEvent(ctx(), ev.id, {
      description: 'Updated live copy',
      questions: [{ label: 'T-shirt size?', type: 'text', required: false }],
    });
    expect(updated.description).toBe('Updated live copy');

    // Approval-gated fields are still rejected on the direct PATCH path.
    await expect(updateEvent(ctx(), ev.id, { name: 'Sneaky Rename' })).rejects.toMatchObject({
      code: 'event_not_draft',
    });
  });
});
