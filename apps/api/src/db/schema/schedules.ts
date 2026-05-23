import { integer, pgTable, time, uuid } from 'drizzle-orm/pg-core';
import { createdAt, uuidPk } from './_columns.js';
import { arenas } from './arenas.js';

/** An Arena's regular weekly availability. Times are venue-local clock times. */
export const weeklySchedule = pgTable('weekly_schedule', {
  id: uuidPk(),
  arenaId: uuid('arena_id')
    .notNull()
    .references(() => arenas.id),
  dayOfWeek: integer('day_of_week').notNull(), // 0 = Sunday … 6 = Saturday
  startTime: time('start_time').notNull(),
  endTime: time('end_time').notNull(),
  slotDurationMin: integer('slot_duration_min').notNull().default(60),
  createdAt: createdAt(),
});

export type WeeklyScheduleRow = typeof weeklySchedule.$inferSelect;
export type NewWeeklyScheduleRow = typeof weeklySchedule.$inferInsert;
