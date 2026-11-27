import { index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { createdAt, uuidPk } from './_columns.js';

/**
 * One row per consumer login code Circls sends itself: Indian numbers while
 * MSG91 login codes are on (see services/phone_login_service.ts). Every other
 * sign-in goes through Firebase phone auth and leaves no row here.
 *
 * Only a hash of the code is kept (sha256 of `<phone>:<code>`). A number's newest
 * row is the only one that can still sign it in: sending a new code retires
 * the older ones. `attempts` counts wrong guesses against that code, and
 * `used_at` makes a code single-use. Rows double as the send log the per-number,
 * per-IP and daily limits count, and are purged after 30 days.
 */
export const phoneLoginCodes = pgTable(
  'phone_login_codes',
  {
    id: uuidPk(),
    phoneE164: text('phone_e164').notNull(),
    codeHash: text('code_hash').notNull(),
    // 'msg91' (texted) or 'stub' (logged only — sandbox and tests).
    provider: text('provider').notNull(),
    // MSG91's request_id for the send, to trace delivery in its reports.
    providerRequestId: text('provider_request_id'),
    ip: text('ip'),
    attempts: integer('attempts').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index('phone_login_codes_phone_created_idx').on(t.phoneE164, t.createdAt),
    index('phone_login_codes_ip_created_idx').on(t.ip, t.createdAt),
    index('phone_login_codes_created_idx').on(t.createdAt),
  ],
);

export type PhoneLoginCode = typeof phoneLoginCodes.$inferSelect;
export type NewPhoneLoginCode = typeof phoneLoginCodes.$inferInsert;
