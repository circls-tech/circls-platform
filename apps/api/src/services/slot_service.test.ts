import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db, pingDb } from '../db/client.js';
import { auditLog, arenas, slots, tenants, venues } from '../db/schema/index.js';
import { createPricingRule } from './pricing_service.js';
import {
  bulkUpdateSlots,
  enumerateOccurrences,
  releaseSlots,
} from './slot_service.js';

const runIntegration = Boolean(process.env.RUN_INTEGRATION);

// ---------------------------------------------------------------------------
// Pure unit test — no DB required
// ---------------------------------------------------------------------------
describe('enumerateOccurrences (pure)', () => {
  it('returns exactly 2 occurrences for Saturdays in a 2-week window', () => {
    // 2026-07-04 and 2026-07-11 are Saturdays; 18:00 IST = 12:30 UTC
    const result = enumerateOccurrences(
      '2026-07-01',
      '2026-07-14',
      [{ dayOfWeek: 6, startTimeMin: 1080, durationMin: 60 }],
      'Asia/Kolkata',
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
    );
    expect(result[0]?.endIso).toBe('2026-07-04T13:30:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// Integration tests — require RUN_INTEGRATION=1 and a live database
// ---------------------------------------------------------------------------
describe.skipIf(!runIntegration)('slot_service integration', () => {
  let tenantId: string;
  let venueId: string;
  let arenaId: string;
  const ctx = { tenantId: '', actorUserId: '00000000-0000-0000-0000-000000000001' };

  beforeAll(async () => {
    await pingDb();

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

    // Default pricing rule: ₹500 (50000 paise) for any slot
    await createPricingRule(arenaId, { pricePaise: 50000, priority: 0 });
  });

  afterAll(async () => {
    // Clean up in FK-safe order
    await db.execute(sql`delete from audit_log where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from slots where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from slot_releases where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from pricing_rules where arena_id = ${arenaId}`);
    await db.execute(sql`delete from arenas where id = ${arenaId}`);
    await db.execute(sql`delete from venues where id = ${venueId}`);
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
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
});
