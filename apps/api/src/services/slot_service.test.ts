import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db, pingDb } from '../db/client.js';
import { auditLog, arenas, slots, tenants, users, venues } from '../db/schema/index.js';
import { createPricingRule } from './pricing_service.js';
import { bookSlots } from './booking_service.js';
import {
  bulkUpdateSlots,
  enumerateOccurrences,
  holdSlots,
  releaseHold,
  releaseSlots,
  sweepExpiredHolds,
} from './slot_service.js';

const runIntegration = Boolean(process.env.RUN_INTEGRATION);

// ---------------------------------------------------------------------------
// Pure unit test — no DB required
// ---------------------------------------------------------------------------
describe('enumerateOccurrences (pure)', () => {
  // A "now" well before any window used in these tests, so date math is unaffected.
  const NOW_BEFORE_WINDOW = '2020-01-01T00:00:00.000Z';

  it('returns exactly 2 occurrences for Saturdays in a 2-week window', () => {
    // 2026-07-04 and 2026-07-11 are Saturdays; 18:00 IST = 12:30 UTC
    const result = enumerateOccurrences(
      '2026-07-01',
      '2026-07-14',
      [{ dayOfWeek: 6, startTimeMin: 1080, durationMin: 60 }],
      'Asia/Kolkata',
      NOW_BEFORE_WINDOW,
    );

    expect(result).toHaveLength(2);
    expect(result[0]?.startIso).toBe('2026-07-04T12:30:00.000Z');
    expect(result[1]?.startIso).toBe('2026-07-11T12:30:00.000Z');
  });

  it('returns no occurrences when no cells match the date range weekdays', () => {
    // 2026-07-01 is Wednesday (3); request Sunday (0) only
    const result = enumerateOccurrences(
      '2026-07-01',
      '2026-07-01',
      [{ dayOfWeek: 0, startTimeMin: 600, durationMin: 60 }],
      'Asia/Kolkata',
      NOW_BEFORE_WINDOW,
    );
    expect(result).toHaveLength(0);
  });

  it('correctly handles end time that crosses into next minute band', () => {
    // 1080 + 60 = 1140 min = 19:00 IST = 13:30 UTC
    const result = enumerateOccurrences(
      '2026-07-04',
      '2026-07-04',
      [{ dayOfWeek: 6, startTimeMin: 1080, durationMin: 60 }],
      'Asia/Kolkata',
      NOW_BEFORE_WINDOW,
    );
    expect(result[0]?.endIso).toBe('2026-07-04T13:30:00.000Z');
  });

  it('anchors an overnight cell (startTimeMin >= 1440) to the next calendar day, once', () => {
    // A 1am slot belonging to Saturday's business day is emitted as
    // {dayOfWeek: 6 (Sat), startTimeMin: 1500 = 25:00}. It must resolve to
    // Sunday 01:00 IST (= Sat 19:30 UTC) and be created exactly once — only the
    // Saturday calendar date enumerates it, not Sunday.
    const result = enumerateOccurrences(
      '2026-07-04', // Saturday
      '2026-07-04',
      [{ dayOfWeek: 6, startTimeMin: 1500, durationMin: 60 }],
      'Asia/Kolkata',
      NOW_BEFORE_WINDOW,
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.startIso).toBe('2026-07-04T19:30:00.000Z'); // Sun 01:00 IST
    expect(result[0]?.endIso).toBe('2026-07-04T20:30:00.000Z'); // Sun 02:00 IST
  });

  it('skips occurrences whose start is at or before nowIso, keeps later ones', () => {
    // Two Saturdays: 2026-07-04T12:30Z and 2026-07-11T12:30Z.
    // nowIso == the first occurrence's start → that one is skipped (<=), second kept.
    const result = enumerateOccurrences(
      '2026-07-01',
      '2026-07-14',
      [{ dayOfWeek: 6, startTimeMin: 1080, durationMin: 60 }],
      'Asia/Kolkata',
      '2026-07-04T12:30:00.000Z',
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.startIso).toBe('2026-07-11T12:30:00.000Z');
  });

  it('keeps an occurrence whose start is strictly after nowIso', () => {
    // nowIso one second before the first occurrence → both kept.
    const result = enumerateOccurrences(
      '2026-07-01',
      '2026-07-14',
      [{ dayOfWeek: 6, startTimeMin: 1080, durationMin: 60 }],
      'Asia/Kolkata',
      '2026-07-04T12:29:59.000Z',
    );
    expect(result).toHaveLength(2);
    expect(result[0]?.startIso).toBe('2026-07-04T12:30:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// Integration tests — require RUN_INTEGRATION=1 and a live database
// ---------------------------------------------------------------------------
describe.skipIf(!runIntegration)('slot_service integration', () => {
  let tenantId: string;
  let venueId: string;
  let arenaId: string;
  let actorUserId: string;
  const ctx = { tenantId: '', actorUserId: '' };

  beforeAll(async () => {
    await pingDb();

    // Create a real user row (required by bookings.created_by_user_id FK)
    const [u] = await db
      .insert(users)
      .values({ firebaseUid: `slotsvc-fb-${Date.now()}`, email: `slotsvc-${Date.now()}@test.x` })
      .returning();
    actorUserId = u!.id;

    const [t] = await db
      .insert(tenants)
      .values({ name: 'SlotSvc', slug: `slotsvc-${Date.now()}` })
      .returning();
    const [v] = await db
      .insert(venues)
      .values({ tenantId: t!.id, name: 'V', tzName: 'Asia/Kolkata' })
      .returning();
    const [a] = await db
      .insert(arenas)
      .values({ venueId: v!.id, name: 'A' })
      .returning();

    tenantId = t!.id;
    venueId = v!.id;
    arenaId = a!.id;
    ctx.tenantId = tenantId;
    ctx.actorUserId = actorUserId;

    // Default pricing rule: ₹500 (50000 paise) for any slot
    await createPricingRule(arenaId, { pricePaise: 50000, priority: 0 });
  });

  afterAll(async () => {
    // Clean up in FK-safe order.
    // slots.booking_id → bookings.id, so null out FK before deleting bookings.
    await db.execute(sql`delete from audit_log where tenant_id = ${tenantId}`);
    await db.execute(sql`update slots set booking_id = null where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from bookings where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from slots where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from slot_releases where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from pricing_rules where arena_id = ${arenaId}`);
    await db.execute(sql`delete from arenas where id = ${arenaId}`);
    await db.execute(sql`delete from venues where id = ${venueId}`);
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
    await db.execute(sql`delete from users where id = ${actorUserId}`);
    await closeDb();
  });

  // -------------------------------------------------------------------------
  // releaseSlots
  // -------------------------------------------------------------------------
  describe('releaseSlots', () => {
    it('creates 2 slots for Sat-evening over 2-week window, priced from pricing rule', async () => {
      // 2030-09-07 and 2030-09-14 are Saturdays — far enough out to never land
      // in the past (releaseSlots skips any occurrence at/before "now").
      const result = await releaseSlots(ctx, arenaId, {
        startDate: '2030-09-01',
        endDate: '2030-09-14',
        quantizationMin: 60,
        cells: [{ dayOfWeek: 6, startTimeMin: 1080, durationMin: 60 }],
        // no per-cell price → falls through to pricing rule
      });

      expect(result.created).toBe(2);
      expect(result.skippedConflict).toBe(0);
      expect(result.removed).toBe(0);

      // Verify the created slots have the pricing rule price
      const createdSlots = await db
        .select()
        .from(slots)
        .where(sql`arena_id = ${arenaId} and deleted_at is null`);

      expect(createdSlots).toHaveLength(2);
      for (const s of createdSlots) {
        expect(s.pricePaise).toBe(50000);
        expect(s.status).toBe('open');
      }
    });

    it('persists businessDayStartMin + template onto the arena', async () => {
      await releaseSlots(ctx, arenaId, {
        startDate: '2027-01-02',
        endDate: '2027-01-02',
        quantizationMin: 60,
        cells: [{ dayOfWeek: 6, startTimeMin: 600, durationMin: 60, price: 10000 }],
        businessDayStartMin: 180,
        template: {
          quantizationMin: 60,
          defaultPriceRupees: 500,
          bands: [{ startMin: 360, endMin: 600, priceRupees: 400 }],
        },
      });

      const [a] = await db.select().from(arenas).where(sql`id = ${arenaId}`);
      expect(a?.businessDayStartMin).toBe(180);
      expect(a?.scheduleTemplate).toMatchObject({
        quantizationMin: 60,
        defaultPriceRupees: 500,
        bands: [{ startMin: 360, endMin: 600, priceRupees: 400 }],
      });
    });

    it('leaves 2 matching slots unchanged on a second identical release', async () => {
      // Second release with same date range and cells → nothing to create,
      // nothing to change: the plan matches the existing schedule exactly.
      const result = await releaseSlots(ctx, arenaId, {
        startDate: '2030-09-01',
        endDate: '2030-09-14',
        quantizationMin: 60,
        cells: [{ dayOfWeek: 6, startTimeMin: 1080, durationMin: 60 }],
      });

      expect(result.created).toBe(0);
      expect(result.unchanged).toBe(2);
      expect(result.repriced).toBe(0);
      expect(result.removed).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // releaseSlots — reconciliation against an existing schedule
  // -------------------------------------------------------------------------
  describe('releaseSlots — reconciliation', () => {
    // 2032-03-06 is a Saturday in IST — far-future so nothing lands in the past.
    const DATE = '2032-03-06';
    const range = { startDate: DATE, endDate: DATE, quantizationMin: 60 };
    let bookedSlotId: string;

    /** Load the arena's live (non-deleted) slots on DATE, ordered by start. */
    async function slotsOnDate() {
      const rows = await db
        .select()
        .from(slots)
        .where(
          sql`arena_id = ${arenaId} and deleted_at is null
              and time_range && tstzrange(${DATE + 'T00:00:00Z'}::timestamptz, ${'2032-03-07T00:00:00Z'}::timestamptz, '[)')`,
        )
        .orderBy(sql`lower(time_range)`);
      return rows;
    }

    it('sets up two slots and books the first', async () => {
      const result = await releaseSlots(ctx, arenaId, {
        ...range,
        cells: [
          { dayOfWeek: 6, startTimeMin: 600, durationMin: 60, price: 10000 },
          { dayOfWeek: 6, startTimeMin: 660, durationMin: 60, price: 10000 },
        ],
      });
      expect(result.created).toBe(2);

      const [first] = await slotsOnDate();
      const booking = await bookSlots(ctx, venueId, {
        slotIds: [first!.id],
        customerName: 'Reconcile Guest',
        customerContact: '+91-9000000200',
      });
      expect(booking.status).toBe('confirmed');
      bookedSlotId = first!.id;
    });

    it('repricing updates open slots, keeps the booked one, reports priceChanges', async () => {
      const result = await releaseSlots(ctx, arenaId, {
        ...range,
        cells: [
          { dayOfWeek: 6, startTimeMin: 600, durationMin: 60, price: 20000 },
          { dayOfWeek: 6, startTimeMin: 660, durationMin: 60, price: 20000 },
          { dayOfWeek: 6, startTimeMin: 720, durationMin: 60, price: 20000 },
        ],
      });

      expect(result).toMatchObject({
        created: 1, // the new 12:00 slot
        repriced: 1, // the open 11:00 slot
        keptBooked: 1, // the booked 10:00 slot
        removed: 0,
        unchanged: 0,
        skippedConflict: 0,
      });
      expect(result.priceChanges).toEqual([{ fromPaise: 10000, toPaise: 20000, count: 1 }]);

      const rows = await slotsOnDate();
      expect(rows).toHaveLength(3);
      // Booked slot keeps its original price and status.
      const booked = rows.find((r) => r.id === bookedSlotId);
      expect(booked?.status).toBe('booked');
      expect(booked?.pricePaise).toBe(10000);
    });

    it('shrinking the plan blocks a slot, removes the stale one, keeps the booked one', async () => {
      const result = await releaseSlots(ctx, arenaId, {
        ...range,
        cells: [{ dayOfWeek: 6, startTimeMin: 660, durationMin: 60, price: 20000, blocked: true }],
      });

      expect(result).toMatchObject({
        created: 0,
        blocked: 1, // 11:00 open → blocked
        removed: 1, // 12:00 no longer in the plan
        keptBooked: 1, // 10:00 booked, untouched even though absent from the plan
        repriced: 0,
      });

      const rows = await slotsOnDate();
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.status).sort()).toEqual(['blocked', 'booked']);

      // The stale 12:00 slot was soft-deleted, not hard-deleted.
      const [removedRow] = await db
        .select()
        .from(slots)
        .where(
          sql`arena_id = ${arenaId} and deleted_at is not null
              and lower(time_range) = '2032-03-06T06:30:00.000Z'::timestamptz`,
        );
      expect(removedRow).toBeDefined();
    });

    it('unblocking reports unblocked', async () => {
      const result = await releaseSlots(ctx, arenaId, {
        ...range,
        cells: [{ dayOfWeek: 6, startTimeMin: 660, durationMin: 60, price: 20000 }],
      });
      expect(result).toMatchObject({ unblocked: 1, keptBooked: 1, created: 0, removed: 0 });
    });

    it('a plan overlapping the booked slot skips the conflicting insert', async () => {
      // [10:30, 11:30) overlaps the kept booked [10:00, 11:00) slot; the open
      // 11:00 slot is stale under this plan and gets removed first.
      const result = await releaseSlots(ctx, arenaId, {
        ...range,
        cells: [{ dayOfWeek: 6, startTimeMin: 630, durationMin: 60, price: 20000 }],
      });
      expect(result).toMatchObject({
        created: 0,
        skippedConflict: 1,
        removed: 1,
        keptBooked: 1,
      });

      // Audit trail: removals were recorded.
      const removals = await db
        .select()
        .from(auditLog)
        .where(sql`tenant_id = ${tenantId} and action = 'slot.remove'`);
      expect(removals.length).toBeGreaterThanOrEqual(2);
    });

    it('never removes a boundary-straddling slot from an adjacent business day', async () => {
      // Friday 2032-03-12's business day (day start 03:00, persisted on the
      // arena earlier in this file) owns an overnight slot [Sat 02:00, Sat
      // 04:00) IST that spills past the Friday business-day end (Sat 03:00).
      const spill = await releaseSlots(ctx, arenaId, {
        startDate: '2032-03-12',
        endDate: '2032-03-12',
        quantizationMin: 60,
        cells: [{ dayOfWeek: 5, startTimeMin: 1560, durationMin: 120, price: 10000 }],
      });
      expect(spill.created).toBe(1);

      // Releasing SATURDAY overlaps that spill slot at the window edge, but it
      // belongs to Friday's business day — out of scope, never removed.
      const result = await releaseSlots(ctx, arenaId, {
        startDate: '2032-03-13',
        endDate: '2032-03-13',
        quantizationMin: 60,
        cells: [{ dayOfWeek: 6, startTimeMin: 600, durationMin: 60, price: 10000 }],
      });
      expect(result).toMatchObject({ created: 1, removed: 0, skippedConflict: 0 });

      // The Friday spill slot is still live.
      const [spillRow] = await db
        .select()
        .from(slots)
        .where(
          sql`arena_id = ${arenaId} and deleted_at is null
              and lower(time_range) = '2032-03-12T20:30:00.000Z'::timestamptz`,
        );
      expect(spillRow).toBeDefined();
      expect(spillRow?.status).toBe('open');
    });
  });

  // -------------------------------------------------------------------------
  // bulkUpdateSlots
  // -------------------------------------------------------------------------
  describe('bulkUpdateSlots', () => {
    it('re-prices open slots and writes audit log entries', async () => {
      const existingSlots = await db
        .select()
        .from(slots)
        .where(sql`arena_id = ${arenaId} and deleted_at is null and status = 'open'`);

      expect(existingSlots.length).toBeGreaterThanOrEqual(2);

      const slotIds = existingSlots.map((s) => s.id).slice(0, 2);

      const updated = await bulkUpdateSlots(ctx, slotIds, { price: 75000 });

      expect(updated).toHaveLength(2);
      for (const u of updated) {
        expect(u.pricePaise).toBe(75000);
      }

      // Verify audit log rows written
      const auditRows = await db
        .select()
        .from(auditLog)
        .where(sql`tenant_id = ${tenantId} and action = 'slot.reprice'`);

      expect(auditRows.length).toBeGreaterThanOrEqual(2);
    });

    it('returns [] immediately when patch is empty (no price or blocked)', async () => {
      const existingSlots = await db
        .select()
        .from(slots)
        .where(sql`arena_id = ${arenaId} and deleted_at is null`);

      const slotIds = existingSlots.slice(0, 1).map((s) => s.id);
      const result = await bulkUpdateSlots(ctx, slotIds, {});
      expect(result).toEqual([]);
    });

    it('throws slot_locked when a booked slot is in the update set', async () => {
      const existingSlots = await db
        .select()
        .from(slots)
        .where(sql`arena_id = ${arenaId} and deleted_at is null`);

      const targetSlot = existingSlots[0];
      if (!targetSlot) throw new Error('No slots to test with');

      // Mark one slot as booked via raw SQL
      await db.execute(
        sql`update slots set status = 'booked' where id = ${targetSlot.id}`,
      );

      await expect(
        bulkUpdateSlots(ctx, [targetSlot.id], { price: 90000 }),
      ).rejects.toMatchObject({ code: 'slot_locked' });

      // Restore status for cleanup predictability
      await db.execute(
        sql`update slots set status = 'open' where id = ${targetSlot.id}`,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Real DB-level concurrency race test
  // -------------------------------------------------------------------------
  describe('bookSlots — real DB concurrency', () => {
    it('exactly one wins and one fails with slot_taken when two transactions race', async () => {
      // Release a fresh single slot dedicated to the race test.
      // 2028-01-02 is a Sunday (dayOfWeek 0) in IST — 10:00 IST = 04:30 UTC.
      const raceResult = await releaseSlots(ctx, arenaId, {
        startDate: '2028-01-02',
        endDate: '2028-01-02',
        quantizationMin: 60,
        cells: [{ dayOfWeek: 0, startTimeMin: 600, durationMin: 60, price: 10000 }],
      });
      // exactly 1 slot created
      expect(raceResult.created).toBe(1);

      const [raceSlot] = await db
        .select()
        .from(slots)
        .where(sql`arena_id = ${arenaId} and deleted_at is null and status = 'open' and lower(time_range) = '2028-01-02T04:30:00.000Z'::timestamptz`);

      if (!raceSlot) throw new Error('Race slot not found');

      const slotIds = [raceSlot.id];
      const bookingInput = { slotIds, customerName: 'Racer', customerContact: '0000' };

      // NOTE: app.inject() at the route layer serializes requests in the Fastify
      // test harness, so the "concurrency" test in bookings_slots.test.ts
      // actually races only at DB-transaction level (which is still meaningful —
      // the second UPDATE finds 0 rows to claim and throws slot_taken). This
      // service-layer test uses Promise.allSettled directly against the DB, so
      // the two transactions genuinely race the postgres UPDATE for the same row.
      const results = await Promise.allSettled([
        bookSlots(ctx, venueId, bookingInput),
        bookSlots(ctx, venueId, { ...bookingInput }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const err = (rejected[0] as PromiseRejectedResult).reason as { code: string };
      expect(err.code).toBe('slot_taken');
    });
  });

  // -------------------------------------------------------------------------
  // TASK 1 — Owned holds: the booker can claim their OWN active hold, others
  // cannot, and any expired hold is reclaimable.
  // -------------------------------------------------------------------------
  describe('bookSlots — owned holds', () => {
    /** Release a single far-future slot on `date` (a Sunday) and return its id. */
    async function freshFutureSlot(date: string): Promise<string> {
      const res = await releaseSlots(ctx, arenaId, {
        startDate: date,
        endDate: date,
        quantizationMin: 60,
        cells: [{ dayOfWeek: 0, startTimeMin: 600, durationMin: 60, price: 10000 }],
      });
      expect(res.created).toBe(1);
      const [row] = await db
        .select()
        .from(slots)
        .where(
          sql`arena_id = ${arenaId} and deleted_at is null and lower(time_range) = ${date + 'T04:30:00.000Z'}::timestamptz`,
        );
      if (!row) throw new Error('fresh slot not found');
      return row.id;
    }

    it('booking succeeds when the slot is held by the SAME (booking) user', async () => {
      const slotId = await freshFutureSlot('2030-06-02');

      // Same user (ctx.actorUserId) places the hold.
      await holdSlots(tenantId, ctx.actorUserId, [slotId]);

      const booking = await bookSlots(ctx, venueId, {
        slotIds: [slotId],
        customerName: 'Owner Holder',
        customerContact: '+91-9000000001',
      });
      expect(booking.status).toBe('confirmed');

      const [after] = await db.select().from(slots).where(sql`id = ${slotId}`);
      expect(after?.status).toBe('booked');
      // heldByUserId cleared on successful claim
      expect(after?.heldByUserId).toBeNull();
      expect(after?.holdExpiresAt).toBeNull();
    });

    it('booking throws slot_taken when held by a DIFFERENT user, still active', async () => {
      const slotId = await freshFutureSlot('2030-06-09');

      // A different user holds the slot.
      const [other] = await db
        .insert(users)
        .values({ firebaseUid: `slotsvc-other-${Date.now()}`, email: `other-${Date.now()}@test.x` })
        .returning();
      await holdSlots(tenantId, other!.id, [slotId]);

      await expect(
        bookSlots(ctx, venueId, {
          slotIds: [slotId],
          customerName: 'Loser',
          customerContact: '+91-9000000002',
        }),
      ).rejects.toMatchObject({ code: 'slot_taken' });

      // Slot remains held by the other user (not booked).
      const [after] = await db.select().from(slots).where(sql`id = ${slotId}`);
      expect(after?.status).toBe('held');
      expect(after?.heldByUserId).toBe(other!.id);
    });

    it('booking succeeds when the hold is expired (regardless of holder)', async () => {
      const slotId = await freshFutureSlot('2030-06-16');

      // Some other user holds it, but the hold has already expired.
      const [other] = await db
        .insert(users)
        .values({ firebaseUid: `slotsvc-exp-${Date.now()}`, email: `exp-${Date.now()}@test.x` })
        .returning();
      await holdSlots(tenantId, other!.id, [slotId]);
      // Force the hold into the past.
      await db.execute(
        sql`update slots set hold_expires_at = now() - interval '1 minute' where id = ${slotId}`,
      );

      const booking = await bookSlots(ctx, venueId, {
        slotIds: [slotId],
        customerName: 'Expired Reclaim',
        customerContact: '+91-9000000003',
      });
      expect(booking.status).toBe('confirmed');

      const [after] = await db.select().from(slots).where(sql`id = ${slotId}`);
      expect(after?.status).toBe('booked');
      expect(after?.heldByUserId).toBeNull();
    });

    it('releaseHold clears heldByUserId back to null', async () => {
      const slotId = await freshFutureSlot('2030-07-07');
      await holdSlots(tenantId, ctx.actorUserId, [slotId]);

      let [held] = await db.select().from(slots).where(sql`id = ${slotId}`);
      expect(held?.status).toBe('held');
      expect(held?.heldByUserId).toBe(ctx.actorUserId);

      await releaseHold(tenantId, [slotId]);

      [held] = await db.select().from(slots).where(sql`id = ${slotId}`);
      expect(held?.status).toBe('open');
      expect(held?.heldByUserId).toBeNull();
      expect(held?.holdExpiresAt).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // TASK 2 — Time-awareness: a slot is locked once its start <= now().
  // No create/edit/book in the past. Error code: slot_in_past.
  // -------------------------------------------------------------------------
  describe('time-awareness — no past edit/book', () => {
    /**
     * Insert an open slot whose tstzrange is entirely in the past; return its id.
     * `dateStr` (YYYY-MM-DD) lets each test use a distinct range so the
     * per-arena slots_no_overlap exclusion constraint is never tripped.
     */
    async function insertPastSlot(dateStr: string): Promise<string> {
      const [row] = await db.execute<{ id: string }>(sql`
        insert into slots (tenant_id, arena_id, time_range, price_paise, status)
        values (
          ${tenantId}, ${arenaId},
          tstzrange(${dateStr + 'T10:00:00Z'}::timestamptz, ${dateStr + 'T11:00:00Z'}::timestamptz, '[)'),
          10000, 'open'
        )
        returning id
      `);
      return (row as { id: string }).id;
    }

    it('bulkUpdateSlots on a past slot throws slot_in_past', async () => {
      const pastId = await insertPastSlot('2020-01-01');
      await expect(
        bulkUpdateSlots(ctx, [pastId], { price: 22222 }),
      ).rejects.toMatchObject({ code: 'slot_in_past' });

      // Unchanged price proves the UPDATE did not touch it.
      const [after] = await db.select().from(slots).where(sql`id = ${pastId}`);
      expect(after?.pricePaise).toBe(10000);
    });

    it('bookSlots on a past slot throws slot_in_past', async () => {
      const pastId = await insertPastSlot('2020-02-02');
      await expect(
        bookSlots(ctx, venueId, {
          slotIds: [pastId],
          customerName: 'Time Traveller',
          customerContact: '+91-9000000099',
        }),
      ).rejects.toMatchObject({ code: 'slot_in_past' });

      // Slot stays open (not booked).
      const [after] = await db.select().from(slots).where(sql`id = ${pastId}`);
      expect(after?.status).toBe('open');
    });

    it('a future slot still edits and books fine', async () => {
      // Release a fresh far-future slot (2030-08-04 is a Sunday in IST).
      const res = await releaseSlots(ctx, arenaId, {
        startDate: '2030-08-04',
        endDate: '2030-08-04',
        quantizationMin: 60,
        cells: [{ dayOfWeek: 0, startTimeMin: 600, durationMin: 60, price: 10000 }],
      });
      expect(res.created).toBe(1);
      const [slot] = await db
        .select()
        .from(slots)
        .where(
          sql`arena_id = ${arenaId} and deleted_at is null and lower(time_range) = '2030-08-04T04:30:00.000Z'::timestamptz`,
        );
      const futureId = slot!.id;

      // Edit succeeds.
      const updated = await bulkUpdateSlots(ctx, [futureId], { price: 33333 });
      expect(updated).toHaveLength(1);
      expect(updated[0]?.pricePaise).toBe(33333);

      // Book succeeds.
      const booking = await bookSlots(ctx, venueId, {
        slotIds: [futureId],
        customerName: 'Future Guest',
        customerContact: '+91-9000000100',
      });
      expect(booking.status).toBe('confirmed');
    });
  });

  // -------------------------------------------------------------------------
  // sweepExpiredHolds — the background reaper. Frees holds whose
  // hold_expires_at has passed back to 'open'; leaves everything else alone.
  // -------------------------------------------------------------------------
  describe('sweepExpiredHolds', () => {
    /**
     * Insert a slot with an explicit status and optional hold metadata.
     * Each call uses a distinct future tstzrange (driven by `dateStr`) so the
     * per-arena slots_no_overlap exclusion constraint is never tripped.
     */
    async function insertSlot(
      dateStr: string,
      status: 'open' | 'held' | 'booked',
      holdExpiresSql: string | null,
      heldBy: string | null,
    ): Promise<string> {
      const [row] = await db.execute<{ id: string }>(sql`
        insert into slots (tenant_id, arena_id, time_range, price_paise, status, hold_expires_at, held_by_user_id)
        values (
          ${tenantId}, ${arenaId},
          tstzrange(${dateStr + 'T10:00:00Z'}::timestamptz, ${dateStr + 'T11:00:00Z'}::timestamptz, '[)'),
          10000, ${status},
          ${holdExpiresSql ? sql`${holdExpiresSql}::timestamptz` : sql`null`},
          ${heldBy}
        )
        returning id
      `);
      return (row as { id: string }).id;
    }

    it('frees an expired hold back to open with hold fields nulled, count reflects it', async () => {
      // status='held', hold_expires_at in the past.
      const expiredId = await insertSlot(
        '2031-01-05',
        'held',
        new Date(Date.now() - 60_000).toISOString(),
        actorUserId,
      );

      const freed = await sweepExpiredHolds();
      expect(freed).toBeGreaterThanOrEqual(1);

      const [after] = await db.select().from(slots).where(sql`id = ${expiredId}`);
      expect(after?.status).toBe('open');
      expect(after?.heldByUserId).toBeNull();
      expect(after?.holdExpiresAt).toBeNull();
    });

    it('leaves a still-active hold (future expiry) untouched', async () => {
      const activeId = await insertSlot(
        '2031-02-05',
        'held',
        new Date(Date.now() + 5 * 60_000).toISOString(),
        actorUserId,
      );

      await sweepExpiredHolds();

      const [after] = await db.select().from(slots).where(sql`id = ${activeId}`);
      expect(after?.status).toBe('held');
      expect(after?.heldByUserId).toBe(actorUserId);
      expect(after?.holdExpiresAt).not.toBeNull();
    });

    it('leaves open and booked slots untouched', async () => {
      const openId = await insertSlot('2031-03-05', 'open', null, null);
      const bookedId = await insertSlot('2031-04-05', 'booked', null, null);

      await sweepExpiredHolds();

      const [openAfter] = await db.select().from(slots).where(sql`id = ${openId}`);
      const [bookedAfter] = await db.select().from(slots).where(sql`id = ${bookedId}`);
      expect(openAfter?.status).toBe('open');
      expect(bookedAfter?.status).toBe('booked');
    });

    it('only counts the rows it actually freed', async () => {
      // Sweep first to drain any pre-existing expired holds (the sweep is
      // global, not tenant-scoped), so the next sweep's count is attributable
      // solely to the single hold we introduce below.
      await sweepExpiredHolds();

      const expiredId = await insertSlot(
        '2031-05-05',
        'held',
        new Date(Date.now() - 120_000).toISOString(),
        actorUserId,
      );

      const freed = await sweepExpiredHolds();
      expect(freed).toBe(1);

      const [after] = await db.select().from(slots).where(sql`id = ${expiredId}`);
      expect(after?.status).toBe('open');
    });
  });
});
