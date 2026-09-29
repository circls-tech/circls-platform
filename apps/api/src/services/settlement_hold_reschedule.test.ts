/**
 * A rescheduled event must drag its money's settlement hold with it.
 *
 * The hold is computed from `events.ends_at` at capture time only, so an event
 * moved after tickets sold used to keep releasing against its original end
 * date — paid out before the event happened (moved later), or held past its
 * settlement week (moved earlier). These cover the re-anchor, driven through
 * the real edit path (`updateEvent` → `applyEventPatchTx`, which is also what
 * an approved change request runs).
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db, pingDb } from '../db/client.js';
import { bookings, payments, tenants, users, venues } from '../db/schema/index.js';
import { env } from '../config/env.js';
import { createEvent, updateEvent } from './events_service.js';
import { reholdForEvent } from './settlement_hold_service.js';

const runIntegration = Boolean(process.env.RUN_INTEGRATION);

const BUFFER_MS = env.SETTLEMENT_HOLD_BUFFER_MIN * 60_000;

describe.skipIf(!runIntegration)('settlement hold follows a rescheduled event', () => {
  let tenantId: string;
  let venueId: string;
  let actorUserId: string;
  const ctx = () => ({ tenantId, actorUserId });

  const ORIGINAL_END = new Date('2030-06-01T18:00:00.000Z');

  beforeAll(async () => {
    await pingDb();
    const [u] = await db
      .insert(users)
      .values({ firebaseUid: `resched-${Date.now()}`, email: `resched-${Date.now()}@test.x` })
      .returning();
    actorUserId = u!.id;
    const [t] = await db
      .insert(tenants)
      .values({ name: 'Resched Co', slug: `resched-${Date.now()}` })
      .returning();
    tenantId = t!.id;
    const [v] = await db
      .insert(venues)
      .values({ tenantId, name: 'Resched Venue', status: 'active', tzName: 'Asia/Kolkata' })
      .returning();
    venueId = v!.id;
  });

  afterAll(async () => {
    await db.execute(sql`delete from audit_log where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from payments where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from bookings where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from event_ticket_tiers where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from events where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from venues where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
    await db.execute(sql`delete from users where id = ${actorUserId}`);
    await closeDb();
  });

  /**
   * An event ending at {@link ORIGINAL_END} with `tickets` separate bookings
   * sold and captured, each held against that end date exactly as the capture
   * path would have. `overrides` lets a case mark the charges released or
   * refunded first. More than one booking matters: the bulk re-hold correlates
   * a subquery per row in its SET clause, and a single-booking event can't tell
   * a correct correlation from one that resolves against the wrong row.
   */
  async function seedSoldEvent(
    label: string,
    overrides: { status?: string; releasedAt?: string; tickets?: number } = {},
  ): Promise<{ eventId: string; paymentIds: string[] }> {
    const ev = await createEvent(ctx(), {
      tenantId,
      venueId,
      name: `Sold ${label}`,
      startsAt: new Date(ORIGINAL_END.getTime() - 2 * 3_600_000),
      endsAt: ORIGINAL_END,
      tiers: [{ name: 'General', pricePaise: 50000 }],
    });

    const paymentIds: string[] = [];
    for (let i = 0; i < (overrides.tickets ?? 1); i++) {
      const [b] = await db
        .insert(bookings)
        .values({
          tenantId,
          venueId,
          itemType: 'event',
          channel: 'circls',
          paymentMethod: 'razorpay_route',
          status: 'confirmed',
          customerName: `Ticket Holder ${i}`,
          totalPaise: 50000,
          itemData: { eventId: ev.id, eventName: ev.name },
          createdByUserId: actorUserId,
        })
        .returning();

      const [pay] = await db.execute<{ id: string }>(sql`
        insert into payments (
          booking_id, tenant_id, provider, provider_payment_id, amount_paise,
          status, kind, settlement_hold_until, settlement_released_at
        ) values (
          ${b!.id}::uuid, ${tenantId}::uuid, 'stub',
          ${`pay_${label}_${i}_${Date.now()}`}, 50000,
          ${overrides.status ?? 'captured'}, 'charge',
          ${ORIGINAL_END.toISOString()}::timestamptz
            + (${env.SETTLEMENT_HOLD_BUFFER_MIN}::int * interval '1 minute'),
          ${overrides.releasedAt ?? null}::timestamptz
        ) returning id
      `);
      paymentIds.push((pay as { id: string }).id);
    }

    return { eventId: ev.id, paymentIds };
  }

  async function holdOf(paymentId: string): Promise<Date | null> {
    const [row] = await db.select().from(payments).where(sql`id = ${paymentId}`);
    return row?.settlementHoldUntil ?? null;
  }

  it('pushes the hold out when the event moves later — on every ticket sold', async () => {
    const { eventId, paymentIds } = await seedSoldEvent('later', { tickets: 3 });
    expect(paymentIds).toHaveLength(3);
    for (const id of paymentIds) {
      expect((await holdOf(id))?.getTime()).toBe(ORIGINAL_END.getTime() + BUFFER_MS);
    }

    const newEnd = new Date('2030-07-15T18:00:00.000Z');
    await updateEvent(ctx(), eventId, {
      startsAt: new Date(newEnd.getTime() - 2 * 3_600_000),
      endsAt: newEnd,
    });

    // Each row individually: the bulk UPDATE resolves its anchor per booking,
    // so a mis-correlated subquery would show up as a shared or missing value.
    for (const id of paymentIds) {
      expect((await holdOf(id))?.getTime()).toBe(newEnd.getTime() + BUFFER_MS);
    }
  });

  it('pulls the hold in when the event moves earlier', async () => {
    const { eventId, paymentIds } = await seedSoldEvent('earlier');
    const paymentId = paymentIds[0]!;

    const newEnd = new Date('2030-05-02T18:00:00.000Z');
    await updateEvent(ctx(), eventId, {
      startsAt: new Date(newEnd.getTime() - 2 * 3_600_000),
      endsAt: newEnd,
    });

    const hold = await holdOf(paymentId);
    expect(hold?.getTime()).toBe(newEnd.getTime() + BUFFER_MS);
    expect(hold!.getTime()).toBeLessThan(ORIGINAL_END.getTime() + BUFFER_MS);
  });

  it('leaves an already-released charge alone — that money is in a paid week', async () => {
    const { eventId, paymentIds } = await seedSoldEvent('released', {
      releasedAt: '2026-01-05T00:00:00.000Z',
    });
    const paymentId = paymentIds[0]!;
    const before = await holdOf(paymentId);

    await updateEvent(ctx(), eventId, {
      startsAt: new Date('2030-09-01T16:00:00.000Z'),
      endsAt: new Date('2030-09-01T18:00:00.000Z'),
    });

    expect((await holdOf(paymentId))?.getTime()).toBe(before!.getTime());
  });

  it('moves a charge refunded before its hold elapsed — it still has to release', async () => {
    const { eventId, paymentIds } = await seedSoldEvent('partial', {
      status: 'partially_refunded',
    });
    const paymentId = paymentIds[0]!;

    const newEnd = new Date('2030-08-20T18:00:00.000Z');
    await updateEvent(ctx(), eventId, {
      startsAt: new Date(newEnd.getTime() - 2 * 3_600_000),
      endsAt: newEnd,
    });

    expect((await holdOf(paymentId))?.getTime()).toBe(newEnd.getTime() + BUFFER_MS);
  });

  it('never invents a hold for money that never came through Route', async () => {
    // Paid at the venue: no hold, and payout reconciliation ignores the row.
    // A reschedule must not drag it into the settlement ledger.
    const ev = await createEvent(ctx(), {
      tenantId,
      venueId,
      name: 'Walk-in Sold',
      startsAt: new Date(ORIGINAL_END.getTime() - 2 * 3_600_000),
      endsAt: ORIGINAL_END,
      tiers: [{ name: 'General', pricePaise: 50000 }],
    });

    const [b] = await db
      .insert(bookings)
      .values({
        tenantId,
        venueId,
        itemType: 'event',
        channel: 'walkin',
        paymentMethod: 'external',
        status: 'confirmed',
        totalPaise: 50000,
        itemData: { eventId: ev.id, eventName: ev.name },
        createdByUserId: actorUserId,
      })
      .returning();

    const [pay] = await db.execute<{ id: string }>(sql`
      insert into payments (
        booking_id, tenant_id, provider, provider_payment_id, amount_paise, status, kind
      ) values (
        ${b!.id}::uuid, ${tenantId}::uuid, 'stub', ${`pay_walkin_${Date.now()}`}, 50000,
        'captured', 'charge'
      ) returning id
    `);
    const paymentId = (pay as { id: string }).id;

    await updateEvent(ctx(), ev.id, {
      startsAt: new Date('2030-10-01T16:00:00.000Z'),
      endsAt: new Date('2030-10-01T18:00:00.000Z'),
    });

    expect(await holdOf(paymentId)).toBeNull();
  });

  it('touches only the rescheduled event’s charges', async () => {
    const mine = await seedSoldEvent('mine', { tickets: 2 });
    const neighbour = await seedSoldEvent('neighbour');
    const untouched = await holdOf(neighbour.paymentIds[0]!);

    const moved = await reholdForEvent(mine.eventId);
    expect(moved).toBe(2);

    expect((await holdOf(neighbour.paymentIds[0]!))?.getTime()).toBe(untouched!.getTime());
  });

  it('resolves the anchor per booking, not once for the whole event', async () => {
    // White-box pin on the bulk UPDATE's correlated subquery. Two bookings on
    // one event normally share an anchor (they share the event's ends_at), so
    // they cannot tell a per-row correlation from one that resolves against an
    // arbitrary booking of the event — a mis-correlation would be invisible.
    // Giving ONE booking a time_range splits the anchors: coalesce prefers
    // upper(time_range) over the event's ends_at, exactly as holdForBooking
    // documents. The shape is synthetic (event bookings carry no time_range in
    // production) and that is the point: it makes the correlation observable.
    const { eventId, paymentIds } = await seedSoldEvent('percorrelation', { tickets: 2 });
    const slotEnd = new Date('2031-01-20T09:00:00.000Z');
    await db.execute(sql`
      update bookings set time_range = tstzrange(
        ${new Date(slotEnd.getTime() - 3_600_000).toISOString()}::timestamptz,
        ${slotEnd.toISOString()}::timestamptz
      )
      where id = (select booking_id from payments where id = ${paymentIds[0]!}::uuid)
    `);

    const newEnd = new Date('2030-11-05T18:00:00.000Z');
    await updateEvent(ctx(), eventId, {
      startsAt: new Date(newEnd.getTime() - 2 * 3_600_000),
      endsAt: newEnd,
    });

    // The booking with a time_range anchors on its own range; the other on the
    // event's new end. Same statement, two different values.
    expect((await holdOf(paymentIds[0]!))?.getTime()).toBe(slotEnd.getTime() + BUFFER_MS);
    expect((await holdOf(paymentIds[1]!))?.getTime()).toBe(newEnd.getTime() + BUFFER_MS);
  });

  it('floors the new hold at now + buffer when the event moves into the past', async () => {
    // Nothing stops a reschedule to a past date — the only window validation is
    // starts_at < ends_at — e.g. correcting an end date typed a year out. The
    // money must not become instantly releasable with no refund window left.
    const { eventId, paymentIds } = await seedSoldEvent('past', { tickets: 2 });

    const before = Date.now();
    await updateEvent(ctx(), eventId, {
      startsAt: new Date('2020-03-01T16:00:00.000Z'),
      endsAt: new Date('2020-03-01T18:00:00.000Z'),
    });
    const after = Date.now();

    for (const id of paymentIds) {
      const hold = (await holdOf(id))!.getTime();
      // Floored to roughly now + buffer, nowhere near the 2020 end date.
      // Generous skew either side: now() is the DB clock, not this process's.
      expect(hold).toBeGreaterThan(before);
      expect(hold).toBeGreaterThanOrEqual(before + BUFFER_MS - 60_000);
      expect(hold).toBeLessThanOrEqual(after + BUFFER_MS + 60_000);
    }
  });
});
