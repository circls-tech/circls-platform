import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type User, users } from '../db/schema/index.js';

export interface FirebaseIdentity {
  firebaseUid: string;
  phoneE164: string | null;
  email: string | null;
}

/**
 * Find the user for a Firebase UID, creating it on first sight. Safe under
 * concurrent first-calls: the unique index on firebase_uid + onConflictDoNothing
 * means at most one row is created; the loser re-reads the winner's row.
 */
export async function findOrCreateByFirebaseUid(identity: FirebaseIdentity): Promise<User> {
  const existing = await db.query.users.findFirst({
    where: eq(users.firebaseUid, identity.firebaseUid),
  });
  if (existing) return existing;

  const inserted = await db
    .insert(users)
    .values({
      firebaseUid: identity.firebaseUid,
      phoneE164: identity.phoneE164,
      email: identity.email,
    })
    .onConflictDoNothing({ target: users.firebaseUid })
    .returning();
  if (inserted[0]) return inserted[0];

  const afterRace = await db.query.users.findFirst({
    where: eq(users.firebaseUid, identity.firebaseUid),
  });
  if (!afterRace) throw new Error('failed to create or load user');
  return afterRace;
}
