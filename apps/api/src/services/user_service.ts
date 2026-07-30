import { and, eq, isNull, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { isUniqueViolation } from '../db/errors.js';
import { type User, users } from '../db/schema/index.js';

export interface FirebaseIdentity {
  firebaseUid: string;
  phoneE164: string | null;
  /** Only ever set when Firebase verified ownership (require_auth C1 gate). */
  email: string | null;
}

/**
 * Find the user for a Firebase UID, creating it on first sight. Safe under
 * concurrent first-calls: the unique index on firebase_uid + onConflictDoNothing
 * means at most one row is created; the loser re-reads the winner's row.
 *
 * `users` also has UNIQUE(phone_e164) and UNIQUE(email). A returning person can
 * arrive with a brand-new firebase_uid but a phone/email that already lives on a
 * row (e.g. a recreated Firebase account, or a switched sign-in provider). The
 * firebase-uid-only upsert below does NOT cover those constraints, so without
 * adoption the insert would 500 on first login. `adoptStaleIdentity` migrates the
 * old row onto the new uid instead.
 *
 * Email trust: `identity.email` is always Firebase-verified, but `users.email`
 * may also hold self-reported (unverified) addresses from the consumer profile
 * PATCH. Only verified emails act as identity keys — adoption ignores
 * unverified rows, and uniqueness is verified-only, so a verified claimant and
 * any number of unverified contact copies of the same address coexist.
 */
export async function findOrCreateByFirebaseUid(identity: FirebaseIdentity): Promise<User> {
  const existing = await db.query.users.findFirst({
    where: eq(users.firebaseUid, identity.firebaseUid),
  });
  if (existing) return backfillVerifiedEmail(existing, identity);

  // Adopt a pre-existing row keyed on this person's unique phone/verified-email
  // before the insert can trip users_phone_e164_unique / the verified-email
  // unique index.
  const adopted = await adoptStaleIdentity(identity);
  if (adopted) return backfillVerifiedEmail(adopted, identity);

  const inserted = await db
    .insert(users)
    .values({
      firebaseUid: identity.firebaseUid,
      phoneE164: identity.phoneE164,
      email: identity.email,
      emailVerified: identity.email !== null,
    })
    .onConflictDoNothing({ target: users.firebaseUid })
    .returning();
  if (inserted[0]) return inserted[0];

  const afterRace = await db.query.users.findFirst({
    where: eq(users.firebaseUid, identity.firebaseUid),
  });
  if (afterRace) return afterRace;

  // A concurrent caller may have created/adopted via the phone/email path.
  const afterIdentityRace = await adoptStaleIdentity(identity);
  if (!afterIdentityRace) throw new Error('failed to create or load user');
  return afterIdentityRace;
}

/**
 * Look up a `users` row by the unique identity columns present on `identity`
 * (phone_e164 and/or verified email) and, if found under a different
 * firebase_uid, migrate it onto the new uid so the caller's Firebase identity
 * becomes canonical. Returns the (now-current) row, or null if no identity
 * match exists. Rows holding `identity.email` unverified are NOT a match —
 * a self-reported email is contact info, not proof the rows are the same human.
 */
async function adoptStaleIdentity(identity: FirebaseIdentity): Promise<User | null> {
  // Build the OR over only the identity fields we actually have — never match on
  // a NULL phone/email (every row without one would collide).
  const predicates = [
    identity.phoneE164 ? eq(users.phoneE164, identity.phoneE164) : undefined,
    identity.email
      ? and(eq(users.email, identity.email), eq(users.emailVerified, true))
      : undefined,
  ].filter((p): p is NonNullable<typeof p> => p !== undefined);
  if (predicates.length === 0) return null;

  const match = await db.query.users.findFirst({ where: or(...predicates) });
  if (!match) return null;
  if (match.firebaseUid === identity.firebaseUid) return match;

  // `match` is this person's row under a stale firebase_uid. Migrate it onto the
  // new uid. We only ever set firebase_uid here: the matched identity column
  // (phone_e164 or email) already equals identity's value, and refreshing the
  // *other* column from `identity` could collide with a different row's unique
  // value — the conservative move is to leave the existing contact fields intact
  // and let an explicit profile update change them later. firebase_uid itself is
  // free because the caller's findFirst(firebaseUid) returned nothing.
  const [migrated] = await db
    .update(users)
    .set({ firebaseUid: identity.firebaseUid })
    .where(eq(users.id, match.id))
    .returning();
  return migrated ?? null;
}

/**
 * Reconcile the caller's own row with a token-verified email claim:
 *   - row has no email → write it (verified);
 *   - row already holds the SAME email unverified (self-reported earlier, or
 *     backfilled-unverified by migration) → promote it to verified;
 *   - row holds a different email → leave it alone (an explicit profile
 *     update, not a login, should change it).
 * Unverified copies of the address on other rows are untouched — they're
 * contact info and coexist under the verified-only unique index. Best-effort:
 * a login must never fail because the write lost a race with another VERIFIED
 * holder, so unique-violations fall back to the unchanged row.
 */
async function backfillVerifiedEmail(row: User, identity: FirebaseIdentity): Promise<User> {
  if (!identity.email) return row;

  try {
    if (row.email === identity.email) {
      if (row.emailVerified) return row;
      const [promoted] = await db
        .update(users)
        .set({ emailVerified: true })
        .where(eq(users.id, row.id))
        .returning();
      return promoted ?? row;
    }

    if (row.email !== null) return row;
    const [updated] = await db
      .update(users)
      .set({ email: identity.email, emailVerified: true })
      .where(and(eq(users.id, row.id), isNull(users.email)))
      .returning();
    return updated ?? row;
  } catch (err) {
    if (isUniqueViolation(err)) return row;
    throw err;
  }
}
