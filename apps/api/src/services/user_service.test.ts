import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const { db, closeDb } = await import('../db/client.js');
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

  beforeEach(async () => {
    await db.execute(sql`delete from users where phone_e164 = ${phone} or email = ${email}`);
  });

  afterAll(async () => {
    await db.execute(sql`delete from users where phone_e164 = ${phone} or email = ${email}`);
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
});
