import { eq, inArray, or, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const { db, closeDb } = await import('../db/client.js');
const { users } = await import('../db/schema/index.js');
const { findOrCreateByFirebaseUid } = await import('./user_service.js');

const runIntegration = Boolean(process.env.RUN_INTEGRATION);

/**
 * Reproduces the consumer "first login → 500" bug. Consumers sign in with
 * phone-OTP, so phone_e164 is the unique identity. When a person's Firebase
 * account is recreated (new firebase_uid) but the old `users` row still carries
 * their phone, the insert in findOrCreate hits the phone_e164 unique constraint
 * — NOT the firebase_uid target of onConflictDoNothing — and used to 500.
 */
describe.skipIf(!runIntegration)('findOrCreateByFirebaseUid identity collisions', () => {
  const phone = '+919999000111';
  const email = 'collide.user@example.com';
  // Every uid the suite creates — evicted-squat rows lose their email (and may
  // have no phone), so cleanup must also match on firebase_uid.
  const UIDS = [
    'fb_new_1', 'fb_old', 'fb_recreated', 'fb_old_e', 'fb_recreated_e', 'fb_v_1',
    'fb_squatter', 'fb_owner', 'fb_bf', 'fb_squatter2', 'fb_bf2', 'fb_legit', 'fb_bf3',
    'fb_up',
  ];

  async function cleanup(): Promise<void> {
    await db
      .delete(users)
      .where(
        or(eq(users.phoneE164, phone), eq(users.email, email), inArray(users.firebaseUid, UIDS)),
      );
  }

  beforeEach(cleanup);

  afterAll(async () => {
    await cleanup();
    await closeDb();
  });

  it('creates a fresh row on genuine first sight', async () => {
    const u = await findOrCreateByFirebaseUid({ firebaseUid: 'fb_new_1', phoneE164: phone, email: null });
    expect(u.firebaseUid).toBe('fb_new_1');
    expect(u.phoneE164).toBe(phone);
  });

  it('adopts the existing row when a NEW firebase_uid reuses a known phone (phone-OTP re-login)', async () => {
    // Seed the lingering row under the OLD firebase_uid.
    const first = await findOrCreateByFirebaseUid({ firebaseUid: 'fb_old', phoneE164: phone, email: null });

    // Same human, recreated Firebase account → brand-new uid, same phone.
    const second = await findOrCreateByFirebaseUid({ firebaseUid: 'fb_recreated', phoneE164: phone, email: null });

    // Must resolve to the same person, with the firebase_uid migrated forward.
    expect(second.id).toBe(first.id);
    expect(second.firebaseUid).toBe('fb_recreated');
  });

  it('adopts the existing row when a NEW firebase_uid reuses a known email', async () => {
    const first = await findOrCreateByFirebaseUid({ firebaseUid: 'fb_old_e', phoneE164: null, email });
    const second = await findOrCreateByFirebaseUid({ firebaseUid: 'fb_recreated_e', phoneE164: null, email });
    expect(second.id).toBe(first.id);
    expect(second.firebaseUid).toBe('fb_recreated_e');
  });

  it('creation marks a token email verified', async () => {
    const u = await findOrCreateByFirebaseUid({ firebaseUid: 'fb_v_1', phoneE164: null, email });
    expect(u.emailVerified).toBe(true);
  });

  it('does NOT adopt a row holding the email unverified; verified claimant coexists with it', async () => {
    // Contact copy: phone user who self-reported the same email (profile PATCH).
    const [contact] = await db
      .insert(users)
      .values({ firebaseUid: 'fb_squatter', phoneE164: phone, email, emailVerified: false })
      .returning();

    // Rightful owner signs in with a Firebase-verified token for that email.
    const owner = await findOrCreateByFirebaseUid({ firebaseUid: 'fb_owner', phoneE164: null, email });

    expect(owner.id).not.toBe(contact!.id);
    expect(owner.email).toBe(email);
    expect(owner.emailVerified).toBe(true);

    // The unverified copy survives — it's contact info, not an identity claim.
    const contactAfter = await db.query.users.findFirst({
      where: sql`firebase_uid = 'fb_squatter'`,
    });
    expect(contactAfter?.email).toBe(email);
    expect(contactAfter?.emailVerified).toBe(false);
  });

  it('backfills a verified token email onto an email-less existing row', async () => {
    // Row created by phone-OTP (no email), then the same Firebase account
    // returns with a verified email claim (e.g. provider linked later).
    const first = await findOrCreateByFirebaseUid({ firebaseUid: 'fb_bf', phoneE164: phone, email: null });
    expect(first.email).toBeNull();

    const second = await findOrCreateByFirebaseUid({ firebaseUid: 'fb_bf', phoneE164: phone, email });
    expect(second.id).toBe(first.id);
    expect(second.email).toBe(email);
    expect(second.emailVerified).toBe(true);
  });

  it('backfill coexists with an unverified copy of the same email', async () => {
    await db
      .insert(users)
      .values({ firebaseUid: 'fb_squatter2', email, emailVerified: false });
    const mine = await findOrCreateByFirebaseUid({ firebaseUid: 'fb_bf2', phoneE164: phone, email: null });

    const after = await findOrCreateByFirebaseUid({ firebaseUid: 'fb_bf2', phoneE164: phone, email });
    expect(after.id).toBe(mine.id);
    expect(after.email).toBe(email);
    expect(after.emailVerified).toBe(true);

    const contactAfter = await db.query.users.findFirst({
      where: sql`firebase_uid = 'fb_squatter2'`,
    });
    expect(contactAfter?.email).toBe(email);
    expect(contactAfter?.emailVerified).toBe(false);
  });

  it('promotes the row\'s own unverified email once the token proves it', async () => {
    // Self-reported (or migration-backfilled-unverified) email on the caller's
    // own row; a verified token claim for the SAME address flips it.
    await db
      .insert(users)
      .values({ firebaseUid: 'fb_up', phoneE164: phone, email, emailVerified: false });

    const after = await findOrCreateByFirebaseUid({ firebaseUid: 'fb_up', phoneE164: phone, email });
    expect(after.email).toBe(email);
    expect(after.emailVerified).toBe(true);
  });

  it('backfill never steals a VERIFIED email — login proceeds with row unchanged', async () => {
    // Another account legitimately owns the email (verified).
    await db
      .insert(users)
      .values({ firebaseUid: 'fb_legit', email, emailVerified: true });
    const mine = await findOrCreateByFirebaseUid({ firebaseUid: 'fb_bf3', phoneE164: phone, email: null });

    // Same uid returns claiming that email: adoption would have matched the
    // verified row only for a NEW uid; for an existing row the backfill must
    // not trip the unique constraint or fail the login.
    const after = await findOrCreateByFirebaseUid({ firebaseUid: 'fb_bf3', phoneE164: phone, email });
    expect(after.id).toBe(mine.id);
    expect(after.email).toBeNull();
  });
});
