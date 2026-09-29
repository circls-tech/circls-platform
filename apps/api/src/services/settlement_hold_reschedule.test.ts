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
   * An event ending at {@link ORIGINAL_END} with one ticket sold and captured,
   * held against that end date exactly as the capture path would have.
   * `overrides` lets a case mark the charge released or refunded first.
   */
  async function seedSoldEvent(
    label: string,
    overrides: { status?: string; releasedAt?: string } = {},
  ): Promise<{ eventId: string; paymentId: string }> {
    const ev = await createEvent(ctx(), {
      tenantId,
      venueId,
      name: `Sold ${label}`,
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
        channel: 'circls',
        paymentMethod: 'razorpay_route',
        status: 'confirmed',
        customerName: 'Ticket Holder',
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
        ${b!.id}::uuid, ${tenantId}::uuid, 'stub', ${`pay_${label}_${Date.now()}`}, 50000,
        ${overrides.status ?? 'captured'}, 'charge',
        ${ORIGINAL_END.toISOString()}::timestamptz
          + (${env.SETTLEMENT_HOLD_BUFFER_MIN}::int * interval '1 minute'),
        ${overrides.releasedAt ?? null}::timestamptz
      ) returning id
    `);

    return { eventId: ev.id, paymentId: (pay as { id: string }).id };
  }

  async function holdOf(paymentId: string): Promise<Date | null> {
    const [row] = await db.select().from(payments).where(sql`id = ${paymentId}`);
    return row?.settlementHoldUntil ?? null;
  }

  it('pushes the hold out when the event moves later', async () => {
    const { eventId, paymentId } = await seedSoldEvent('later');
    expect((await holdOf(paymentId))?.getTime()).toBe(ORIGINAL_END.getTime() + BUFFER_MS);

    const newEnd = new Date('2030-07-15T18:00:00.000Z');
    await updateEvent(ctx(), eventId, {
      startsAt: new Date(newEnd.getTime() - 2 * 3_600_000),
      endsAt: newEnd,
    });

    expect((await holdOf(paymentId))?.getTime()).toBe(newEnd.getTime() + BUFFER_MS);
  });

  it('pulls the hold in when the event moves earlier', async () => {
    const { eventId, paymentId } = await seedSoldEvent('earlier');

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
    const { eventId, paymentId } = await seedSoldEvent('released', {
      releasedAt: '2026-01-05T00:00:00.000Z',
    });
    const before = await holdOf(paymentId);

    await updateEvent(ctx(), eventId, {
      startsAt: new Date('2030-09-01T16:00:00.000Z'),
      endsAt: new Date('2030-09-01T18:00:00.000Z'),
    });

    expect((await holdOf(paymentId))?.getTime()).toBe(before!.getTime());
  });

  it('moves a charge refunded before its hold elapsed — it still has to release', async () => {
    const { eventId, paymentId } = await seedSoldEvent('partial', {
      status: 'partially_refunded',
    });

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
    const mine = await seedSoldEvent('mine');
    const neighbour = await seedSoldEvent('neighbour');
    const untouched = await holdOf(neighbour.paymentId);

    const moved = await reholdForEvent(mine.eventId);
    expect(moved).toBe(1);

    expect((await holdOf(neighbour.paymentId))?.getTime()).toBe(untouched!.getTime());
  });
});
