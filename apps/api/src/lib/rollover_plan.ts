import { eq } from 'drizzle-orm';
import type { db } from '../db/client.js';
import { type Arena, arenas } from '../db/schema/index.js';
import { type AuditCtx, writeAudit } from './audit.js';
import { BadRequest } from './errors.js';

/** The weekly plan a partner saves for auto-rollover (see schedule_rollover_service). */
export interface RolloverPlanInput {
  quantizationMin: number;
  businessDayStartMin: number;
  cells: {
    dayOfWeek: number;
    startTimeMin: number;
    durationMin: number;
    price?: number | null;
    blocked?: boolean;
  }[];
}

export interface RolloverChange {
  enabled: boolean;
  /** Replaces the saved plan. Required the first time rollover is switched on. */
  plan?: RolloverPlanInput;
}

type Tx = Pick<typeof db, 'update' | 'insert'>;

/**
 * The one place auto-rollover state changes — used by both the release path
 * (`autoRollover: true|false` on a release) and PUT /rollover — so the two can
 * never disagree on validation, what gets stored, or how it is audited.
 *
 * Saving a plan also moves the arena's business-day boundary to the plan's,
 * exactly as a release does, so the reception grid and the saved plan agree
 * from the moment it is saved. Switching off keeps the plan.
 */
export async function applyRolloverChange(
  tx: Tx,
  ctx: AuditCtx,
  existing: Arena,
  change: RolloverChange,
): Promise<Arena> {
  if (change.plan && change.plan.cells.length === 0) {
    throw new BadRequest('The rolling plan needs at least one slot', 'rollover_plan_empty');
  }
  if (change.enabled && !change.plan && !existing.rolloverPlan) {
    throw new BadRequest(
      'Build and save a weekly schedule before switching auto-rollover on',
      'rollover_plan_required',
    );
  }

  const now = new Date();
  const patch: Partial<typeof arenas.$inferInsert> = {
    autoRolloverEnabled: change.enabled,
    rolloverUpdatedAt: now,
  };
  if (change.plan) {
    patch.rolloverPlan = {
      quantizationMin: change.plan.quantizationMin,
      businessDayStartMin: change.plan.businessDayStartMin,
      cells: change.plan.cells,
      savedByUserId: ctx.actorUserId,
      savedAt: now.toISOString(),
    };
    patch.businessDayStartMin = change.plan.businessDayStartMin;
  }

  const [updated] = await tx.update(arenas).set(patch).where(eq(arenas.id, existing.id)).returning();
  if (!updated) throw new Error('arena update returned no row');

  await writeAudit(
    tx,
    ctx,
    'arena.rollover',
    'arena',
    existing.id,
    { autoRolloverEnabled: existing.autoRolloverEnabled, planCells: existing.rolloverPlan?.cells.length ?? null },
    { autoRolloverEnabled: updated.autoRolloverEnabled, planCells: updated.rolloverPlan?.cells.length ?? null },
  );
  return updated;
}
