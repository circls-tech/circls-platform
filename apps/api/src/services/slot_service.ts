import { and, eq, getTableColumns, inArray, notInArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { isExclusionViolation } from '../db/errors.js';
import { arenas, type ScheduleTemplate, type Slot, slotReleases, slots } from '../db/schema/index.js';
import { Conflict } from '../lib/errors.js';
import { type AuditCtx, writeAudit } from '../lib/audit.js';
import { resolvePricePaise } from './pricing_service.js';
import { getArenaById } from './arena_service.js';
import { getVenueById } from './venue_service.js';

/** Slot row extended with ISO-string bounds extracted from the tstzrange. */
export type SlotWithBounds = Slot & { startAt: string; endAt: string };

export interface ReleaseCell {
  dayOfWeek: number;
  startTimeMin: number;
  durationMin: number;
  price?: number | null;
  blocked?: boolean;
}

export interface ReleaseInput {
  startDate: string;
  endDate: string;
  quantizationMin: number;
  cells: ReleaseCell[];
  /** Persisted on the arena so the builder & reception grid agree on the day boundary. */
  businessDayStartMin?: number;
  /** Last-used builder template, persisted on the arena for prefill next time. */
  template?: ScheduleTemplate;
}

export interface Occurrence {
  startIso: string;
  endIso: string;
  price: number | null;
  blocked: boolean;
}

/** One from→to price-change group in a release summary. */
export interface PriceChange {
  fromPaise: number;
  toPaise: number;
  count: number;
}

/**
 * What a release actually did, slot by slot. A release *reconciles* the plan
 * against the existing schedule rather than blindly inserting:
 * - `created`   — new slots inserted.
 * - `repriced`  — existing non-booked slots whose price changed (grouped in
 *                 `priceChanges` as from→to buckets).
 * - `blocked` / `unblocked` — existing non-booked slots whose status flipped.
 * - `removed`   — existing non-booked slots inside the released business days
 *                 that no longer appear in the plan (soft-deleted).
 * - `unchanged` — existing slots that already matched the plan exactly.
 * - `keptBooked` — booked/held slots left untouched, whatever the plan said.
 * - `skippedConflict` — planned slots not created because they overlap a kept
 *                 (booked/held) slot at a different grid position.
 */
export interface ReleaseSummary {
  created: number;
  repriced: number;
  blocked: number;
  unblocked: number;
  removed: number;
  unchanged: number;
  keptBooked: number;
  skippedConflict: number;
  priceChanges: PriceChange[];
}

// ---------------------------------------------------------------------------
// Timezone helpers
// ---------------------------------------------------------------------------
//
// NOTE — DST / large-offset limitation:
// Assumes a non-DST timezone (Asia/Kolkata, the only venue tz today).
// The local→UTC offset sampling in `localMinutesToUtcIso` and the noon-UTC
// weekday sample in `weekdayInTz` are NOT correct for DST-observing or
// UTC+12+ zones — revisit before onboarding such venues.
// ---------------------------------------------------------------------------

/** Minutes in a business day. */
const DAY_MIN = 1440;

const WEEKDAY: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * Given a local date string (YYYY-MM-DD) and a wall-clock offset in minutes from
 * local midnight, compute the UTC ISO instant at which the local clock reads
 * exactly `localMinutes` past midnight on that date in `tz`.
 *
 * Strategy: seed a candidate UTC timestamp (date@UTC + localMinutes), format it
 * in the target tz to discover the actual local wall-clock reading at that UTC
 * moment, derive the tz offset from the difference, then correct.
 */
function localMinutesToUtcIso(dateStr: string, localMinutes: number, tz: string): string {
  const dateUtcMidnight = Date.UTC(
    parseInt(dateStr.slice(0, 4), 10),
    parseInt(dateStr.slice(5, 7), 10) - 1,
    parseInt(dateStr.slice(8, 10), 10),
  );
  const approxUtcMs = dateUtcMidnight + localMinutes * 60_000;

  // Read back the local wall-clock time at this UTC moment.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(approxUtcMs));

  const get = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? '0';

  const rawHour = parseInt(get('hour'), 10);
  const localHour = rawHour === 24 ? 0 : rawHour; // ICU emits '24' at some midnights

  // "As-if UTC" of the local reading — used to compute the tz offset.
  const localWallClockAsUtcMs = Date.UTC(
    parseInt(get('year'), 10),
    parseInt(get('month'), 10) - 1,
    parseInt(get('day'), 10),
    localHour,
    parseInt(get('minute'), 10),
  );
  // e.g. for IST (UTC+5:30): tzOffsetMs = approxUtcMs - localWallClockAsUtcMs < 0
  const tzOffsetMs = approxUtcMs - localWallClockAsUtcMs;

  // UTC instant = local-midnight-as-UTC + localMinutes + tzOffset
  return new Date(dateUtcMidnight + localMinutes * 60_000 + tzOffsetMs).toISOString();
}

/**
 * Returns the weekday (0=Sun … 6=Sat) of a YYYY-MM-DD date string in `tz`.
 * Samples at noon UTC to avoid DST edge-cases near local midnight.
 */
function weekdayInTz(dateStr: string, tz: string): number {
  const noonUtc = new Date(
    Date.UTC(
      parseInt(dateStr.slice(0, 4), 10),
      parseInt(dateStr.slice(5, 7), 10) - 1,
      parseInt(dateStr.slice(8, 10), 10),
      12, // noon UTC
    ),
  );
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
  }).formatToParts(noonUtc);
  const wd = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun';
  return WEEKDAY[wd] ?? 0;
}

/** Advance a YYYY-MM-DD date string by one calendar day. */
function nextDay(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------------

/**
 * PURE — exported for unit testing.
 * For each calendar date in [startDate, endDate] inclusive, and each cell whose
 * dayOfWeek matches that date's weekday IN `tz`, yields one Occurrence.
 *
 * Occurrences whose start instant is at or before `nowIso` are skipped — a slot
 * may never be created in the past. ISO-8601 instants in UTC ('…Z') compare
 * correctly as strings, so the `<=` comparison is lexicographic and exact.
 *
 * NOTE — DST / large-offset limitation: assumes a non-DST timezone
 * (Asia/Kolkata). See the header comment on the timezone helpers above.
 */
export function enumerateOccurrences(
  startDate: string,
  endDate: string,
  cells: ReleaseCell[],
  tz: string,
  nowIso: string,
): Occurrence[] {
  const occurrences: Occurrence[] = [];
  let current = startDate;

  while (current <= endDate) {
    const dow = weekdayInTz(current, tz);

    for (const cell of cells) {
      if (cell.dayOfWeek !== dow) continue;

      const startIso = localMinutesToUtcIso(current, cell.startTimeMin, tz);
      // Skip occurrences that have already started (or start exactly now).
      if (startIso <= nowIso) continue;

      occurrences.push({
        startIso,
        endIso: localMinutesToUtcIso(current, cell.startTimeMin + cell.durationMin, tz),
        price: cell.price ?? null,
        blocked: cell.blocked ?? false,
      });
    }

    current = nextDay(current);
  }

  return occurrences;
}

/** An existing slot row as loaded for reconciliation. */
interface ExistingSlotRow {
  id: string;
  pricePaise: number;
  status: Slot['status'];
  startIso: string;
  endIso: string;
}

export async function releaseSlots(
  ctx: AuditCtx,
  arenaId: string,
  input: ReleaseInput,
): Promise<ReleaseSummary> {
  const arena = await getArenaById(arenaId);
  if (!arena) throw new Conflict('Arena not found', 'arena_not_found');
  const venue = await getVenueById(arena.venueId);
  const tz = venue?.tzName ?? 'Asia/Kolkata';
  const dayStartMin = input.businessDayStartMin ?? arena.businessDayStartMin ?? 0;

  return db.transaction(async (tx) => {
    // Persist the day boundary + builder template on the arena so the builder
    // prefills next time and the reception grid renders the same business day.
    const arenaPatch: Partial<typeof arenas.$inferInsert> = {};
    if (input.businessDayStartMin !== undefined)
      arenaPatch.businessDayStartMin = input.businessDayStartMin;
    if (input.template !== undefined) arenaPatch.scheduleTemplate = input.template;
    if (Object.keys(arenaPatch).length > 0) {
      await tx.update(arenas).set(arenaPatch).where(eq(arenas.id, arenaId));
    }

    const [rel] = await tx
      .insert(slotReleases)
      .values({
        tenantId: ctx.tenantId,
        arenaId,
        startDate: new Date(input.startDate),
        endDate: new Date(input.endDate),
        quantizationMin: input.quantizationMin,
      })
      .returning();

    const summary: ReleaseSummary = {
      created: 0,
      repriced: 0,
      blocked: 0,
      unblocked: 0,
      removed: 0,
      unchanged: 0,
      keptBooked: 0,
      skippedConflict: 0,
      priceChanges: [],
    };

    // Pass the wall-clock now so that releasing a window starting today
    // auto-begins at the first slot boundary strictly after now.
    const nowIso = new Date().toISOString();

    const occurrences = enumerateOccurrences(input.startDate, input.endDate, input.cells, tz, nowIso);
    if (occurrences.length === 0) return summary;

    const price = async (occ: Occurrence): Promise<number> =>
      occ.price ??
      (await resolvePricePaise({ arenaId, startAt: occ.startIso, channel: 'walkin' })) ??
      0;

    // ── Reconciliation window ──
    // The release replaces the schedule for every business day in
    // [startDate, endDate]: from startDate@dayStart to endDate@dayStart+24h,
    // widened to any occurrence that spills past the last business-day end.
    let windowStart = localMinutesToUtcIso(input.startDate, dayStartMin, tz);
    let windowEnd = localMinutesToUtcIso(input.endDate, dayStartMin + DAY_MIN, tz);
    for (const occ of occurrences) {
      if (occ.startIso < windowStart) windowStart = occ.startIso;
      if (occ.endIso > windowEnd) windowEnd = occ.endIso;
    }

    // Existing FUTURE slots in the window. Past slots are never touched.
    const rawExisting = await tx.execute<Record<string, unknown>>(sql`
      select id, price_paise, status,
             lower(time_range) as start_at,
             upper(time_range) as end_at
      from slots
      where arena_id = ${arenaId}
        and deleted_at is null
        and time_range && tstzrange(${windowStart}::timestamptz, ${windowEnd}::timestamptz, '[)')
        and lower(time_range) > now()
    `);
    const existing: ExistingSlotRow[] = (rawExisting as unknown as Record<string, unknown>[]).map(
      (row) => ({
        id: row['id'] as string,
        pricePaise: Number(row['price_paise']),
        status: row['status'] as Slot['status'],
        startIso: new Date(row['start_at'] as string).toISOString(),
        endIso: new Date(row['end_at'] as string).toISOString(),
      }),
    );

    // ── Match plan occurrences to existing slots by exact time range ──
    const byRange = new Map<string, ExistingSlotRow>();
    for (const row of existing) byRange.set(`${row.startIso}|${row.endIso}`, row);

    const matchedIds = new Set<string>();
    const matched: Array<{ occ: Occurrence; row: ExistingSlotRow }> = [];
    const toInsert: Occurrence[] = [];
    for (const occ of occurrences) {
      const row = byRange.get(`${occ.startIso}|${occ.endIso}`);
      if (row && !matchedIds.has(row.id)) {
        matchedIds.add(row.id);
        matched.push({ occ, row });
      } else {
        toInsert.push(occ);
      }
    }

    // ── Remove stale slots first so their ranges are free for re-inserts ──
    // (the slots_no_overlap exclusion constraint ignores soft-deleted rows).
    // Booked/held slots are never removed; the WHERE re-checks status so a
    // concurrent booking between our SELECT and this UPDATE survives.
    const stale = existing.filter((row) => !matchedIds.has(row.id));
    const staleLocked = stale.filter((row) => row.status === 'booked' || row.status === 'held');
    summary.keptBooked += staleLocked.length;

    const removableIds = stale
      .filter((row) => row.status !== 'booked' && row.status !== 'held')
      .map((row) => row.id);
    if (removableIds.length > 0) {
      const deleted = await tx
        .update(slots)
        .set({ deletedAt: new Date() })
        .where(
          and(
            inArray(slots.id, removableIds),
            eq(slots.tenantId, ctx.tenantId),
            notInArray(slots.status, ['booked', 'held']),
            sql`lower(${slots.timeRange}) > now()`,
          ),
        )
        .returning({ id: slots.id });
      summary.removed = deleted.length;
      // Any row that slipped through got booked/held concurrently — kept.
      summary.keptBooked += removableIds.length - deleted.length;

      const staleById = new Map(stale.map((row) => [row.id, row]));
      for (const d of deleted) {
        const before = staleById.get(d.id);
        await writeAudit(
          tx,
          ctx,
          'slot.remove',
          'slot',
          d.id,
          before ? { pricePaise: before.pricePaise, status: before.status } : null,
          { deletedAt: nowIso },
        );
      }
    }

    // ── Update matched slots whose price / blocked status changed ──
    const priceChangeMap = new Map<string, PriceChange>();
    for (const { occ, row } of matched) {
      if (row.status === 'booked' || row.status === 'held') {
        summary.keptBooked++;
        continue;
      }
      const desiredPrice = await price(occ);
      const desiredStatus = occ.blocked ? ('blocked' as const) : ('open' as const);
      const priceDiff = row.pricePaise !== desiredPrice;
      const statusDiff = row.status !== desiredStatus;
      if (!priceDiff && !statusDiff) {
        summary.unchanged++;
        continue;
      }

      const set: Partial<typeof slots.$inferInsert> = {};
      if (priceDiff) set.pricePaise = desiredPrice;
      if (statusDiff) set.status = desiredStatus;

      // TOCTOU guard: refuse to touch a slot that got booked/held (or started)
      // between the reconciliation SELECT and this UPDATE.
      const updated = await tx
        .update(slots)
        .set(set)
        .where(
          and(
            eq(slots.id, row.id),
            eq(slots.tenantId, ctx.tenantId),
            notInArray(slots.status, ['booked', 'held']),
            sql`lower(${slots.timeRange}) > now()`,
          ),
        )
        .returning({ id: slots.id });
      if (updated.length === 0) {
        summary.keptBooked++;
        continue;
      }

      if (priceDiff) {
        summary.repriced++;
        const key = `${row.pricePaise}->${desiredPrice}`;
        const bucket = priceChangeMap.get(key) ?? {
          fromPaise: row.pricePaise,
          toPaise: desiredPrice,
          count: 0,
        };
        bucket.count++;
        priceChangeMap.set(key, bucket);
      }
      if (statusDiff) {
        if (desiredStatus === 'blocked') summary.blocked++;
        else summary.unblocked++;
      }

      const action =
        priceDiff && statusDiff ? 'slot.update' : priceDiff ? 'slot.reprice' : 'slot.block';
      await writeAudit(
        tx,
        ctx,
        action,
        'slot',
        row.id,
        { pricePaise: row.pricePaise, status: row.status },
        set as Record<string, unknown>,
      );
    }
    summary.priceChanges = [...priceChangeMap.values()].sort((a, b) => b.count - a.count);

    // ── Insert plan occurrences with no existing match ──
    for (const occ of toInsert) {
      const insertPrice = await price(occ);
      try {
        // Use a nested transaction (savepoint) so that an exclusion violation
        // only rolls back this single insert, leaving the outer tx intact.
        await tx.transaction(async (stx) => {
          await stx.insert(slots).values({
            tenantId: ctx.tenantId,
            arenaId,
            timeRange: sql`tstzrange(${occ.startIso}::timestamptz, ${occ.endIso}::timestamptz, '[)')`,
            pricePaise: insertPrice,
            status: occ.blocked ? 'blocked' : 'open',
            releaseId: rel!.id,
          });
        });
        summary.created++;
      } catch (err) {
        // Overlaps a kept (booked/held) slot at a different grid position.
        if (isExclusionViolation(err)) summary.skippedConflict++;
        else throw err;
      }
    }

    return summary;
  });
}

export async function listSlots(
  arenaId: string,
  fromIso: string,
  toIso: string,
): Promise<SlotWithBounds[]> {
  // Use a raw SELECT so we can extract lower/upper bounds from the tstzrange column
  // as proper ISO timestamp strings without client-side string parsing.
  const rows = await db.execute<Record<string, unknown>>(sql`
    select *,
           lower(time_range) as start_at,
           upper(time_range) as end_at
    from slots
    where arena_id = ${arenaId}
      and deleted_at is null
      and time_range && tstzrange(${fromIso}::timestamptz, ${toIso}::timestamptz, '[)')
    order by lower(time_range)
  `);

  return (rows as unknown as Record<string, unknown>[]).map((row) => ({
    id: row['id'] as string,
    tenantId: row['tenant_id'] as string,
    arenaId: row['arena_id'] as string,
    timeRange: row['time_range'] as string,
    pricePaise: Number(row['price_paise']),
    status: row['status'] as Slot['status'],
    holdExpiresAt: row['hold_expires_at'] ? new Date(row['hold_expires_at'] as string) : null,
    heldByUserId: (row['held_by_user_id'] as string | null) ?? null,
    bookingId: (row['booking_id'] as string | null) ?? null,
    releaseId: (row['release_id'] as string | null) ?? null,
    deletedAt: row['deleted_at'] ? new Date(row['deleted_at'] as string) : null,
    createdAt: new Date(row['created_at'] as string),
    updatedAt: new Date(row['updated_at'] as string),
    startAt: new Date(row['start_at'] as string).toISOString(),
    endAt: new Date(row['end_at'] as string).toISOString(),
  }));
}

export async function bulkUpdateSlots(
  ctx: AuditCtx,
  slotIds: string[],
  patch: { price?: number; blocked?: boolean },
): Promise<Slot[]> {
  return db.transaction(async (tx) => {
    // `inArray` generates `id IN ($1, $2, …)` with proper individual bindings —
    // avoids the `any(($1,$2)::uuid[])` record-cast error from postgres-js.
    // eq(slots.tenantId, ctx.tenantId) scopes to the caller's tenant.
    // `startsInPast` reads the tstzrange lower bound so we can reject started slots.
    const rows = await tx
      .select({
        ...getTableColumns(slots),
        startsInPast: sql<boolean>`lower(${slots.timeRange}) <= now()`,
      })
      .from(slots)
      .where(and(inArray(slots.id, slotIds), eq(slots.tenantId, ctx.tenantId), sql`${slots.deletedAt} is null`));

    // Pre-SELECT check: eagerly reject if any slot is already locked.
    for (const r of rows) {
      if (r.status === 'booked' || r.status === 'held') {
        throw new Conflict('Slot is locked', 'slot_locked');
      }
      // A slot whose start instant has passed can no longer be edited.
      if (r.startsInPast) {
        throw new Conflict('This slot has already started', 'slot_in_past');
      }
    }

    const set: Partial<typeof slots.$inferInsert> = {};
    if (patch.price !== undefined) set.pricePaise = patch.price;
    if (patch.blocked !== undefined) set.status = patch.blocked ? 'blocked' : 'open';

    // Empty-patch guard: drizzle .set({}) produces invalid SQL — bail early.
    if (Object.keys(set).length === 0) return [];

    // TOCTOU guard: the UPDATE itself excludes booked/held rows so a
    // concurrently-booked slot cannot be silently overwritten, and excludes
    // rows whose start has passed (slot_in_past) — both checked in the WHERE.
    // eq(slots.tenantId, ctx.tenantId) ensures cross-tenant IDs in slotIds are silently ignored.
    const updated = await tx
      .update(slots)
      .set(set)
      .where(
        and(
          inArray(slots.id, slotIds),
          eq(slots.tenantId, ctx.tenantId),
          notInArray(slots.status, ['booked', 'held']),
          sql`lower(${slots.timeRange}) > now()`,
        ),
      )
      .returning();

    // If counts differ, a slot was locked between our SELECT and this UPDATE.
    if (updated.length !== slotIds.length) {
      throw new Conflict('Slot is locked', 'slot_locked');
    }

    // Build a lookup map from the pre-SELECT rows for accurate `before` values.
    const beforeMap = new Map(rows.map((r) => [r.id, { pricePaise: r.pricePaise, status: r.status }]));

    // Determine audit action.
    const bothChanged = patch.price !== undefined && patch.blocked !== undefined;
    const action = bothChanged
      ? 'slot.update'
      : patch.price !== undefined
        ? 'slot.reprice'
        : 'slot.block';

    for (const u of updated) {
      await writeAudit(
        tx,
        ctx,
        action,
        'slot',
        u.id,
        beforeMap.get(u.id) ?? null,
        set as Record<string, unknown>,
      );
    }

    return updated;
  });
}

export async function holdSlots(
  tenantId: string,
  userId: string,
  slotIds: string[],
): Promise<void> {
  await db
    .update(slots)
    .set({ status: 'held', holdExpiresAt: sql`now() + interval '5 minutes'`, heldByUserId: userId })
    .where(and(inArray(slots.id, slotIds), eq(slots.tenantId, tenantId), eq(slots.status, 'open')));
}

export async function releaseHold(tenantId: string, slotIds: string[]): Promise<void> {
  await db
    .update(slots)
    .set({ status: 'open', holdExpiresAt: null, heldByUserId: null })
    .where(and(inArray(slots.id, slotIds), eq(slots.tenantId, tenantId), eq(slots.status, 'held')));
}

/**
 * Reaper for stale holds: flips every slot whose hold has expired
 * (`status='held'` AND `hold_expires_at < now()`, ignoring soft-deleted rows)
 * back to `open`, clearing the hold metadata. Returns the number of rows freed.
 *
 * Tenant-agnostic by design — it sweeps the whole table so a single recurring
 * job covers all tenants. Independent of pg-boss so it stays directly callable
 * (and unit-testable) without booting the worker.
 */
export async function sweepExpiredHolds(): Promise<number> {
  const freed = await db
    .update(slots)
    .set({ status: 'open', holdExpiresAt: null, heldByUserId: null })
    .where(
      and(
        eq(slots.status, 'held'),
        sql`${slots.holdExpiresAt} < now()`,
        sql`${slots.deletedAt} is null`,
      ),
    )
    .returning({ id: slots.id });

  return freed.length;
}
