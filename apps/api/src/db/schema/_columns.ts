import { sql } from 'drizzle-orm';
import { bigint, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Shared column helpers — every table builds on these so the locked
 * schema decisions (UUID v7 PKs, TIMESTAMPTZ, BIGINT paise) are applied
 * consistently and in one place.
 */

/** UUID v7 primary key, generated server-side by Postgres 18's native `uuidv7()`. */
export const uuidPk = () => uuid('id').primaryKey().default(sql`uuidv7()`);

/** TIMESTAMPTZ `created_at`, set to now() at insert. Always UTC at rest. */
export const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

/** TIMESTAMPTZ `updated_at`, set at insert and bumped on every app-side update. */
export const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/**
 * BIGINT money column storing paise (1/100 INR). Never store rupees as floats.
 * Convention: suffix the TS field/variable with `Paise`.
 */
export const bigintPaise = (name: string) => bigint(name, { mode: 'number' });
