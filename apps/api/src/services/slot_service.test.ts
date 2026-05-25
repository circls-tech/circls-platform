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
      const result = await releaseSlots(ctx, arenaId, {
        startDate: '2026-07-01',
        endDate: '2026-07-14',
        quantizationMin: 60,
        cells: [{ dayOfWeek: 6, startTimeMin: 1080, durationMin: 60 }],
        // no per-cell price → falls through to pricing rule
      });

      expect(result.created).toBe(2);
      expect(result.skipped).toBe(0);

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

    it('skips 2 overlapping slots on a second identical release', async () => {
      // Second release with same date range and cells → all should be skipped
      const result = await releaseSlots(ctx, arenaId, {
        startDate: '2026-07-01',
        endDate: '2026-07-14',
        quantizationMin: 60,
        cells: [{ dayOfWeek: 6, startTimeMin: 1080, durationMin: 60 }],
      });

      expect(result.created).toBe(0);
      expect(result.skipped).toBe(2);
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
});
