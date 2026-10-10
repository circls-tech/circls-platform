import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db, pingDb } from '../db/client.js';
import { arenas, auditLog, slots, tenants, users, venues } from '../db/schema/index.js';
import {
  addDays,
  businessDateInTz,
  rolloverArena,
  rolloverHorizonDates,
  runScheduleRollover,
  setArenaRollover,
  unbuiltDates,
} from './schedule_rollover_service.js';
import { releaseSlots } from './slot_service.js';

const runIntegration = Boolean(process.env.RUN_INTEGRATION);
const IST = 'Asia/Kolkata';

// ---------------------------------------------------------------------------
// Pure unit tests — no DB required
// ---------------------------------------------------------------------------
describe('businessDateInTz (pure)', () => {
  it('reads the calendar date in the venue tz with a midnight boundary', () => {
    // 2026-07-04T20:00Z = 2026-07-05 01:30 IST
    expect(businessDateInTz('2026-07-04T20:00:00.000Z', IST, 0)).toBe('2026-07-05');
  });

  it('assigns a post-midnight instant to the previous business day', () => {
    // 01:30 IST with a 03:00 boundary still belongs to the 4th.
    expect(businessDateInTz('2026-07-04T20:00:00.000Z', IST, 180)).toBe('2026-07-04');
    // 03:00 IST sharp is the first minute of the 5th.
    expect(businessDateInTz('2026-07-04T21:30:00.000Z', IST, 180)).toBe('2026-07-05');
  });
});

describe('addDays (pure)', () => {
  it('crosses month and year ends', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('rolloverHorizonDates (pure)', () => {
  it('spans the current business day through 7 days ahead (8 dates)', () => {
    // Saturday 2026-07-04 22:00 IST (= 16:30Z), 03:00 boundary → today is the 4th.
    const dates = rolloverHorizonDates('2026-07-04T16:30:00.000Z', IST, 180);
    expect(dates).toHaveLength(8);
    expect(dates[0]).toBe('2026-07-04');
    expect(dates[7]).toBe('2026-07-11'); // next Saturday
  });

  it('rolls "today" forward only once the business-day boundary passes', () => {
    // 02:00 IST Sunday 5th = 20:30Z Saturday; with a 03:00 boundary it is still the 4th…
    expect(rolloverHorizonDates('2026-07-04T20:30:00.000Z', IST, 180)[0]).toBe('2026-07-04');
    // …and at 03:00 IST it becomes the 5th, so next Sunday (12th) enters the horizon.
    const after = rolloverHorizonDates('2026-07-04T21:30:00.000Z', IST, 180);
    expect(after[0]).toBe('2026-07-05');
    expect(after[7]).toBe('2026-07-12');
  });

  it('honours a custom horizon', () => {
    expect(rolloverHorizonDates('2026-07-04T16:30:00.000Z', IST, 180, 2)).toEqual([
      '2026-07-04',
      '2026-07-05',
      '2026-07-06',
    ]);
  });
});

describe('unbuiltDates (pure)', () => {
  const dates = ['2026-07-04', '2026-07-05', '2026-07-06'];

  it('returns every date when there are no slots', () => {
    expect(unbuiltDates(dates, [], IST, 180)).toEqual(dates);
  });

  it('treats a day with any slot as built', () => {
    // One slot at 18:00 IST on the 5th (= 12:30Z).
    expect(unbuiltDates(dates, ['2026-07-05T12:30:00.000Z'], IST, 180)).toEqual([
      '2026-07-04',
      '2026-07-06',
    ]);
  });

  it('counts an overnight spill toward the business day that owns it', () => {
    // 01:00 IST on the 6th (= 19:30Z on the 5th) belongs to the 5th with a 03:00 boundary,
    // so the 6th is still unbuilt.
    expect(unbuiltDates(dates, ['2026-07-05T19:30:00.000Z'], IST, 180)).toEqual([
      '2026-07-04',
      '2026-07-06',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Integration tests — require RUN_INTEGRATION=1 and a live database
// ---------------------------------------------------------------------------
describe.skipIf(!runIntegration)('schedule_rollover_service integration', () => {
  let tenantId: string;
  let venueId: string;
  let arenaId: string;
  let actorUserId: string;
  const ctx = { tenantId: '', actorUserId: '' };

  // A Saturday evening far enough out that nothing lands in the past:
  // 2033-07-02 is a Saturday. 22:00 IST = 16:30Z.
  const NOW = '2033-07-02T16:30:00.000Z';
  const DAY_START = 180;
  // 18:00–20:00 every day at ₹500, plus a 01:00 overnight slot so spill is exercised.
  const plan = {
    quantizationMin: 60,
    businessDayStartMin: DAY_START,
    cells: [0, 1, 2, 3, 4, 5, 6].flatMap((dow) => [
      { dayOfWeek: dow, startTimeMin: 1080, durationMin: 60, price: 50000 },
      { dayOfWeek: dow, startTimeMin: 1140, durationMin: 60, price: 50000 },
      { dayOfWeek: dow, startTimeMin: 1500, durationMin: 60, price: 30000 },
    ]),
  };

  async function liveSlotStarts(): Promise<string[]> {
    const rows = await db.execute<Record<string, unknown>>(sql`
      select lower(time_range) as start_at from slots
      where arena_id = ${arenaId} and deleted_at is null order by lower(time_range)
    `);
    return (rows as unknown as Record<string, unknown>[]).map((r) =>
      new Date(r['start_at'] as string).toISOString(),
    );
  }

  beforeAll(async () => {
    await pingDb();
    const [u] = await db
      .insert(users)
      .values({ firebaseUid: `rollover-fb-${Date.now()}`, email: `rollover-${Date.now()}@test.x` })
      .returning();
    actorUserId = u!.id;
    const [t] = await db
      .insert(tenants)
      .values({ name: 'RolloverCo', slug: `rollover-${Date.now()}` })
      .returning();
    const [v] = await db
      .insert(venues)
      .values({ tenantId: t!.id, name: 'V', tzName: IST, status: 'active' })
      .returning();
    const [a] = await db
      .insert(arenas)
      .values({ venueId: v!.id, name: 'A', status: 'active' })
      .returning();
    tenantId = t!.id;
    venueId = v!.id;
    arenaId = a!.id;
    ctx.tenantId = tenantId;
    ctx.actorUserId = actorUserId;
  });

  afterAll(async () => {
    await db.execute(sql`delete from audit_log where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from slots where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from slot_releases where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from arenas where id = ${arenaId}`);
    await db.execute(sql`delete from venues where id = ${venueId}`);
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
    await db.execute(sql`delete from users where id = ${actorUserId}`);
    await closeDb();
  });

  it('refuses to switch on without a plan, or with an empty one', async () => {
    await expect(setArenaRollover(ctx, arenaId, { enabled: true })).rejects.toMatchObject({
      code: 'rollover_plan_required',
    });
    await expect(
      setArenaRollover(ctx, arenaId, { enabled: true, plan: { ...plan, cells: [] } }),
    ).rejects.toMatchObject({ code: 'rollover_plan_empty' });
    // Same rule on the release path.
    await expect(
      releaseSlots(ctx, arenaId, {
        startDate: '2033-07-02',
        endDate: '2033-07-02',
        quantizationMin: 60,
        cells: [],
        autoRollover: true,
      }),
    ).rejects.toMatchObject({ code: 'rollover_plan_empty' });
    const [a] = await db.select().from(arenas).where(sql`id = ${arenaId}`);
    expect(a?.autoRolloverEnabled).toBe(false);
  });

  it('saves the plan, switches on, and audits it', async () => {
    const a = await setArenaRollover(ctx, arenaId, { enabled: true, plan });
    expect(a.autoRolloverEnabled).toBe(true);
    expect(a.rolloverPlan?.cells).toHaveLength(21);
    // Saving a plan moves the arena's boundary to the plan's, like a release does.
    expect(a.businessDayStartMin).toBe(DAY_START);
    expect(a.rolloverPlan?.savedByUserId).toBe(actorUserId);
    expect(a.rolloverUpdatedAt).not.toBeNull();

    const [audit] = await db
      .select()
      .from(auditLog)
      .where(sql`tenant_id = ${tenantId} and action = 'arena.rollover'`);
    expect(audit?.entityId).toBe(arenaId);
  });

  it('releases every day in the horizon that has no slots', async () => {
    const saved = (await db.query.arenas.findFirst({ where: sql`id = ${arenaId}` }))!;
    const r = await rolloverArena(arenaId, tenantId, IST, saved.businessDayStartMin, saved.rolloverPlan!, NOW);
    expect(r.daysReleased).toBe(8); // today (2nd) … next Saturday (9th)
    expect(r.slotsCreated).toBe(24); // 3 slots × 8 days, all in the future

    const starts = await liveSlotStarts();
    expect(starts).toHaveLength(24);
    // First slot: 18:00 IST on the 2nd = 12:30Z.
    expect(starts[0]).toBe('2033-07-02T12:30:00.000Z');
    // Last slot: 01:00 IST on the 10th (spill of the 9th) = 19:30Z on the 9th.
    expect(starts[starts.length - 1]).toBe('2033-07-09T19:30:00.000Z');

    const [a] = await db.select().from(arenas).where(sql`id = ${arenaId}`);
    expect(a?.rolloverLastRunAt?.toISOString()).toBe(NOW);
  });

  it('is idempotent: a second run at the same time creates nothing', async () => {
    const r = await runScheduleRollover(NOW);
    expect(r.arenas).toBeGreaterThanOrEqual(1);
    expect(r.failed).toBe(0);
    expect(await liveSlotStarts()).toHaveLength(24);
  });

  it('builds only the newly-entered day once the business day rolls over', async () => {
    // 03:00 IST on the 3rd (= 21:30Z on the 2nd): today is now the 3rd, so the
    // 10th enters the horizon. Only that day is built; the 2nd's slots stay.
    const r = await runScheduleRollover('2033-07-02T21:30:00.000Z');
    expect(r.daysReleased).toBe(1);
    expect(r.slotsCreated).toBe(3);
    expect(await liveSlotStarts()).toHaveLength(27);
  });

  it('leaves a day the partner released by hand exactly as they made it', async () => {
    // Partner hand-releases the 11th with one differently-priced slot and a
    // different business-day boundary …
    await releaseSlots(ctx, arenaId, {
      startDate: '2033-07-11',
      endDate: '2033-07-11',
      quantizationMin: 60,
      cells: [{ dayOfWeek: 1, startTimeMin: 600, durationMin: 60, price: 99900 }],
      businessDayStartMin: 360,
    });
    // … then the 11th enters the horizon (now = 03:00 IST on the 4th — which,
    // on the arena's new 06:00 boundary, is still the 3rd, so nothing new
    // enters; the 11th is built already either way).
    const r = await runScheduleRollover('2033-07-03T21:30:00.000Z');
    expect(r.daysReleased).toBe(0);
    // The auto-release never writes the boundary back.
    const [after] = await db.select().from(arenas).where(sql`id = ${arenaId}`);
    expect(after?.businessDayStartMin).toBe(360);
    const starts = await liveSlotStarts();
    expect(starts).toHaveLength(28);
    const [hand] = await db
      .select()
      .from(slots)
      .where(sql`arena_id = ${arenaId} and deleted_at is null and lower(time_range) = ${'2033-07-11T04:30:00.000Z'}::timestamptz`);
    expect(hand?.pricePaise).toBe(99900);
  });

  it('a replaced plan applies to days generated from then on only', async () => {
    const cheaper = {
      ...plan,
      cells: plan.cells.map((c) => ({ ...c, price: 10000 })),
    };
    await setArenaRollover(ctx, arenaId, { enabled: true, plan: cheaper });
    // Saving the plan restored the 03:00 boundary; now = 03:00 IST on the 5th
    // → the 12th enters the horizon.
    const r = await runScheduleRollover('2033-07-04T21:30:00.000Z');
    expect(r.daysReleased).toBe(1);
    const [newSlot] = await db
      .select()
      .from(slots)
      .where(sql`arena_id = ${arenaId} and deleted_at is null and lower(time_range) = ${'2033-07-12T12:30:00.000Z'}::timestamptz`);
    expect(newSlot?.pricePaise).toBe(10000);
    const [oldSlot] = await db
      .select()
      .from(slots)
      .where(sql`arena_id = ${arenaId} and deleted_at is null and lower(time_range) = ${'2033-07-09T12:30:00.000Z'}::timestamptz`);
    expect(oldSlot?.pricePaise).toBe(50000);
  });

  it('pauses while the arena is closed and stops when switched off', async () => {
    await db.update(arenas).set({ status: 'suspended' }).where(sql`id = ${arenaId}`);
    const paused = await runScheduleRollover('2033-07-05T21:30:00.000Z');
    expect(paused.daysReleased).toBe(0);
    await db.update(arenas).set({ status: 'active' }).where(sql`id = ${arenaId}`);

    const a = await setArenaRollover(ctx, arenaId, { enabled: false });
    expect(a.autoRolloverEnabled).toBe(false);
    expect(a.rolloverPlan).not.toBeNull(); // kept for switching back on
    const off = await runScheduleRollover('2033-07-05T21:30:00.000Z');
    expect(off.daysReleased).toBe(0);
  });
});
