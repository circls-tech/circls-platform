import { and, eq, notInArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type Arena, arenas, type RolloverPlan, tenants, venues } from '../db/schema/index.js';
import type { AuditCtx } from '../lib/audit.js';
import { NotFound } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { applyRolloverChange, type RolloverChange } from '../lib/rollover_plan.js';
import { localMinutesToUtcIso, releaseSlots } from './slot_service.js';

/**
 * Auto-rollover for arena schedules.
 *
 * A partner who builds a weekly schedule can save it as the arena's *rolling
 * plan*. From then on the worker keeps the next ROLLOVER_HORIZON_DAYS business
 * days released from that plan, so a day never goes unbookable because nobody
 * remembered to extend the schedule. When Saturday ends, next Saturday is
 * built overnight — unless it already was.
 *
 * Two rules keep this safe to run every hour against every tenant:
 *
 * 1. **Only days with no slots at all are generated.** A day the partner has
 *    already released (by hand or by a previous rollover) is never touched, so
 *    their per-day edits — repricing, blocking, a one-off closure — survive.
 *    Each generated day goes through the normal release path, so booked slots
 *    and the audit trail behave exactly as for a manual release.
 * 2. **The plan is a snapshot.** Editing the builder changes nothing until the
 *    partner saves the plan again; the new plan applies to days generated
 *    from then on, never retroactively.
 *
 * Auto-releases are audited as the team member who saved the plan — they are
 * the person who asked for the automation.
 *
 * The arena's *current* business-day boundary decides which day a slot belongs
 * to and which day is "today" — the same boundary the reception grid uses.
 * Saving a plan moves that boundary to the plan's (like a release does), but an
 * auto-release never writes it back, so a later one-off release with a
 * different boundary is respected rather than undone an hour later.
 */

/** How many business days ahead the worker keeps released (today + N). */
export const ROLLOVER_HORIZON_DAYS = 7;

const DAY_MIN = 1440;

/** 'YYYY-MM-DD' calendar date of an instant in `tz`. */
function dateStrInTz(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

/**
 * PURE. The business date ('YYYY-MM-DD') that owns instant `iso` in `tz`,
 * given the arena's business-day boundary: 01:00 on the 5th with a 03:00
 * boundary still belongs to the 4th.
 */
export function businessDateInTz(iso: string, tz: string, dayStartMin: number): string {
  return dateStrInTz(Date.parse(iso) - dayStartMin * 60_000, tz);
}

/** Advance a 'YYYY-MM-DD' date string by `n` calendar days. */
export function addDays(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * PURE. The business dates rollover keeps released as of `nowIso`: the current
 * business day (so a partner who only released through today gets tonight's
 * remaining slots filled too — release itself never creates past slots)
 * through `horizonDays` days ahead.
 */
export function rolloverHorizonDates(
  nowIso: string,
  tz: string,
  dayStartMin: number,
  horizonDays: number = ROLLOVER_HORIZON_DAYS,
): string[] {
  const today = businessDateInTz(nowIso, tz, dayStartMin);
  const dates: string[] = [];
  for (let i = 0; i <= horizonDays; i++) dates.push(addDays(today, i));
  return dates;
}

/**
 * PURE. Which of `dates` have no slot yet — a slot belongs to the business
 * date that owns its start instant.
 */
export function unbuiltDates(
  dates: string[],
  slotStartIsos: string[],
  tz: string,
  dayStartMin: number,
): string[] {
  const built = new Set(slotStartIsos.map((iso) => businessDateInTz(iso, tz, dayStartMin)));
  return dates.filter((d) => !built.has(d));
}

// ---------------------------------------------------------------------------
// Partner-facing: switch rollover on/off, save the plan
// ---------------------------------------------------------------------------

export type SetRolloverInput = RolloverChange;

/**
 * Switch auto-rollover on or off for an arena and/or replace its rolling plan.
 * Switching off keeps the saved plan so it can be switched back on as it was.
 */
export async function setArenaRollover(
  ctx: AuditCtx,
  arenaId: string,
  input: SetRolloverInput,
): Promise<Arena> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(arenas)
      .where(eq(arenas.id, arenaId))
      .limit(1)
      .for('update');
    if (!existing) throw new NotFound('Arena not found', 'arena_not_found');
    return applyRolloverChange(tx, ctx, existing, input);
  });
}

// ---------------------------------------------------------------------------
// Worker: keep the horizon released
// ---------------------------------------------------------------------------

export interface RolloverRunSummary {
  /** Arenas with rollover on that were checked. */
  arenas: number;
  /** Business days that had no slots and were released. */
  daysReleased: number;
  /** Slots created across those days. */
  slotsCreated: number;
  /** Arenas whose run threw (logged; the others still ran). */
  failed: number;
}

/**
 * Release, for every arena with auto-rollover on, each business day in the
 * horizon that has no slots yet. Tenant-agnostic so one hourly job covers
 * everyone; idempotent, so running it more often than needed is harmless.
 *
 * Paused for closed (`suspended`) or rejected arenas, closed venues, and
 * suspended organisations — a closed arena should not quietly keep filling
 * up with bookable slots.
 */
export async function runScheduleRollover(
  nowIso: string = new Date().toISOString(),
): Promise<RolloverRunSummary> {
  const summary: RolloverRunSummary = { arenas: 0, daysReleased: 0, slotsCreated: 0, failed: 0 };

  const targets = await db
    .select({
      arenaId: arenas.id,
      plan: arenas.rolloverPlan,
      dayStartMin: arenas.businessDayStartMin,
      tenantId: venues.tenantId,
      tz: venues.tzName,
    })
    .from(arenas)
    .innerJoin(venues, eq(venues.id, arenas.venueId))
    .innerJoin(tenants, eq(tenants.id, venues.tenantId))
    .where(
      and(
        eq(arenas.autoRolloverEnabled, true),
        sql`${arenas.rolloverPlan} is not null`,
        notInArray(arenas.status, ['suspended', 'rejected']),
        notInArray(venues.status, ['suspended', 'rejected']),
        eq(tenants.status, 'active'),
      ),
    );

  const checked: string[] = [];
  for (const t of targets) {
    const plan = t.plan as RolloverPlan | null;
    if (!plan || plan.cells.length === 0) continue;
    summary.arenas++;
    try {
      const r = await rolloverArena(t.arenaId, t.tenantId, t.tz, t.dayStartMin, plan, nowIso);
      summary.daysReleased += r.daysReleased;
      summary.slotsCreated += r.slotsCreated;
      checked.push(t.arenaId);
    } catch (err) {
      summary.failed++;
      logger.error({ err, arenaId: t.arenaId }, 'schedule_rollover_arena_failed');
    }
  }

  // One statement for every arena checked, and raw SQL on purpose: the ORM
  // would also bump `updated_at` on each row, turning "the partner changed
  // this arena" into hourly noise for every arena on rollover.
  if (checked.length > 0) {
    // One array literal as a single bound parameter (the sql template would
    // otherwise spread a JS array into N parameters).
    const ids = `{${checked.join(',')}}`;
    await db.execute(sql`
      update arenas set rollover_last_run_at = ${nowIso}::timestamptz
      where id = any(${ids}::uuid[])
    `);
  }

  return summary;
}

/**
 * One arena's rollover: find the unbuilt days in the horizon and release them.
 * `dayStartMin` is the arena's current business-day boundary.
 */
export async function rolloverArena(
  arenaId: string,
  tenantId: string,
  tz: string,
  dayStartMin: number,
  plan: RolloverPlan,
  nowIso: string,
): Promise<{ daysReleased: number; slotsCreated: number }> {
  const dates = rolloverHorizonDates(nowIso, tz, dayStartMin);
  const first = dates[0]!;
  const last = dates[dates.length - 1]!;

  // Every live slot starting anywhere in the horizon's business window; the
  // "built" test is per business day, so an overnight spill counts for the day
  // it belongs to, not the calendar day it lands on.
  const windowStart = localMinutesToUtcIso(first, dayStartMin, tz);
  const windowEnd = localMinutesToUtcIso(last, dayStartMin + DAY_MIN, tz);
  const rows = await db.execute<Record<string, unknown>>(sql`
    select lower(time_range) as start_at
    from slots
    where arena_id = ${arenaId}
      and deleted_at is null
      and lower(time_range) >= ${windowStart}::timestamptz
      and lower(time_range) < ${windowEnd}::timestamptz
  `);
  const starts = (rows as unknown as Record<string, unknown>[]).map((r) =>
    new Date(r['start_at'] as string).toISOString(),
  );

  const todo = unbuiltDates(dates, starts, tz, dayStartMin);
  const out = { daysReleased: 0, slotsCreated: 0 };
  const ctx: AuditCtx = { tenantId, actorUserId: plan.savedByUserId };

  for (const date of todo) {
    // One release per day keeps each day's reconciliation window to itself and
    // means a failure part-way leaves whole days either built or not. No
    // businessDayStartMin / template: an auto-release must not rewrite the
    // arena's settings — releaseSlots reconciles on the arena's own boundary.
    const result = await releaseSlots(ctx, arenaId, {
      startDate: date,
      endDate: date,
      quantizationMin: plan.quantizationMin,
      cells: plan.cells,
    });
    out.daysReleased++;
    out.slotsCreated += result.created;
  }

  if (out.daysReleased > 0) {
    logger.info({ arenaId, days: todo, created: out.slotsCreated }, 'schedule_rollover_released');
  }
  return out;
}
