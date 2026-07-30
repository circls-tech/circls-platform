import { sql } from 'drizzle-orm';
import { boolean, pgEnum, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, updatedAt, uuidPk } from './_columns.js';

/** One row per human. Same User signs in on circls.app and partners.circls.app. */
export const userStatus = pgEnum('user_status', ['active', 'suspended']);

export const users = pgTable(
  'users',
  {
    id: uuidPk(),
    firebaseUid: text('firebase_uid').notNull().unique(),
    phoneE164: text('phone_e164').unique(),
    /**
     * Uniqueness is verified-only (see index below): at most one row may hold
     * an address as a proven identity key, while any number of rows may carry
     * the same address unverified as plain contact info (e.g. a consumer keeps
     * their receipt email even though the partner credential owns the address).
     */
    email: text('email'),
    /**
     * Whether `email` is proven to belong to this person (verified Firebase token
     * or possession of an invite token sent to it). Only verified emails may act
     * as identity keys (adoptStaleIdentity); a self-reported profile email is
     * contact info only.
     */
    emailVerified: boolean('email_verified').notNull().default(false),
    displayName: text('display_name'),
    interests: text('interests').array().notNull().default(sql`'{}'::text[]`),
    status: userStatus('status').notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('users_email_verified_unique').on(t.email).where(sql`${t.emailVerified} = true`),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
