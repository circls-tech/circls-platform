import { sql } from 'drizzle-orm';
import { pgEnum, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, updatedAt, uuidPk } from './_columns.js';

/** One row per human. Same User signs in on circls.app and partners.circls.app. */
export const userStatus = pgEnum('user_status', ['active', 'suspended']);

export const users = pgTable('users', {
  id: uuidPk(),
  firebaseUid: text('firebase_uid').notNull().unique(),
  phoneE164: text('phone_e164').unique(),
  email: text('email').unique(),
  displayName: text('display_name'),
  interests: text('interests').array().notNull().default(sql`'{}'::text[]`),
  status: userStatus('status').notNull().default('active'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
