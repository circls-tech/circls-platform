import { sql } from 'drizzle-orm';
import { boolean, index, pgEnum, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, updatedAt, uuidPk } from './_columns.js';

/** One row per human. Same User signs in on circls.app and partners.circls.app. */
export const userStatus = pgEnum('user_status', ['active', 'suspended']);

export const users = pgTable(
  'users',
  {
    id: uuidPk(),
    /**
     * Unique among LIVE rows only (see the partial indexes below): a deleted
     * account keeps its real uid so the login path can recognise and refuse it,
     * which means the same uid may also exist on one or more tombstones.
     */
    firebaseUid: text('firebase_uid').notNull(),
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
    /**
     * Tombstone marker for a self-service account deletion (DELETE
     * /v1/consumer/me). The row is never dropped — bookings/payments reference
     * it and must survive for financial retention — so deletion means: clear
     * the contact columns (phone_e164/email → NULL, display_name → NULL,
     * interests → {}) and stamp this column, while KEEPING firebase_uid so the
     * login path can recognise the dead account and refuse it (401
     * `account_deleted`) rather than minting a fresh row from the token claims.
     *
     * With both identity keys NULL, a returning person's phone/email can never
     * adopt this row (see user_service.adoptStaleIdentity) — re-signup mints a
     * fresh user.
     */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('users_email_verified_unique').on(t.email).where(sql`${t.emailVerified} = true`),
    // Partial: at most one LIVE row per Firebase uid. Tombstones keep their uid
    // (so a deleted account is recognisable) and are excluded from uniqueness.
    uniqueIndex('users_firebase_uid_live_unique')
      .on(t.firebaseUid)
      .where(sql`${t.deletedAt} is null`),
    // Serves the cold-path tombstone lookup in findOrCreateByFirebaseUid, which
    // the live-only unique index above cannot answer.
    index('users_firebase_uid_deleted_idx')
      .on(t.firebaseUid)
      .where(sql`${t.deletedAt} is not null`),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
