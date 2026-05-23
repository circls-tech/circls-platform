import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type WeeklyScheduleRow, weeklySchedule } from '../db/schema/index.js';

export interface ScheduleRowInput {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  slotDurationMin?: number | undefined;
}

/** Replace an arena's entire weekly schedule atomically. */
export async function setWeeklySchedule(
  arenaId: string,
  rows: ScheduleRowInput[],
): Promise<WeeklyScheduleRow[]> {
  return db.transaction(async (tx) => {
    await tx.delete(weeklySchedule).where(eq(weeklySchedule.arenaId, arenaId));
    if (rows.length === 0) return [];
    return tx
      .insert(weeklySchedule)
      .values(
        rows.map((r) => ({
          arenaId,
          dayOfWeek: r.dayOfWeek,
          startTime: r.startTime,
          endTime: r.endTime,
          slotDurationMin: r.slotDurationMin ?? 60,
        })),
      )
      .returning();
  });
}

export async function getWeeklySchedule(arenaId: string): Promise<WeeklyScheduleRow[]> {
  return db.select().from(weeklySchedule).where(eq(weeklySchedule.arenaId, arenaId));
}
