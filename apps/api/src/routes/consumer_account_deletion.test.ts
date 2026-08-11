import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// DELETE /v1/consumer/me — consumer account deletion (Google Play / App Store
// compliance). Proves the anonymise-never-hard-delete contract: the users row
// loses every identity/PII field, the behavioural + support trail is cleared,
// public thread content survives under an anonymous author, and bookings (the
// financial record we must retain) are byte-for-byte untouched.
// Integration (RUN_INTEGRATION + a real Postgres).
//
/**
 * A fake Firebase Auth BACKEND, stubbed at the Admin SDK boundary so the real
 * `lib/firebase_admin.ts` runs on top of it.
 *
 * This shape is load-bearing. The review of PR #173 found that mocking
 * `deleteFirebaseUser` itself — as one atomic throw — hid the actual bug: token
 * validity has to FOLLOW from what teardown really did, or "can the caller
 * retry?" is an assumption the test encodes rather than a question it answers.
 * Because the real module is in the loop here, re-introducing the old
 * revoke-before-delete ordering turns the retry test below red.
 *
 *  - `deleted` — uids whose account is gone; their tokens stop verifying with
 *    `auth/user-not-found`, exactly like production.
 *  - `revoked` — uids whose refresh tokens were revoked; `verifyIdToken` rejects
 *    them because our wrapper always passes checkRevoked=true.
 *  - `failNext` — the next `deleteUser` throws WITHOUT deleting, modelling a
 *    Firebase 5xx/timeout.
 *
 * RUN makes every identity unique per run so the suite is re-runnable against a
 * persistent DB (deleted rows keep their user id forever).
 */
const H = vi.hoisted(() => {
  const RUN = Date.now();
  // firebase_admin.app() checks env before initialising even though the SDK
  // itself is stubbed — take the local-sandbox branch so no service account is
  // needed. (env.ts only forbids this var when NODE_ENV=production.)
  process.env['FIREBASE_AUTH_EMULATOR_HOST'] ??= 'localhost:9099';
  const phone = `+9199${String(RUN).slice(-8)}`;
  return {
    RUN,
    phone,
    personas: {
      victim: { uid: `fbuid_victim_ad_${RUN}`, phone_number: phone },
      // Same phone as `victim`, brand-new Firebase uid: the re-signup case.
      resignup: { uid: `fbuid_resignup_ad_${RUN}`, phone_number: phone },
      flaky: { uid: `fbuid_flaky_ad_${RUN}`, phone_number: `+9188${String(RUN).slice(-8)}` },
      owner: { uid: `fbuid_owner_ad_${RUN}`, email: `owner_ad_${RUN}@x.com`, email_verified: true },
      partner: { uid: `fbuid_partner_ad_${RUN}`, email: `partner_ad_${RUN}@x.com`, email_verified: true },
      invitee: { uid: `fbuid_invitee_ad_${RUN}`, email: `invitee_ad_${RUN}@x.com`, email_verified: true },
    } as Record<string, Record<string, unknown>>,
    calls: [] as string[],
    deleted: new Set<string>(),
    revoked: new Set<string>(),
    failNext: false,
  };
});

vi.mock('firebase-admin/app', () => ({
  getApps: () => [],
  initializeApp: vi.fn(() => ({ name: 'account-deletion-test-app' })),
  cert: vi.fn(() => ({ kind: 'cert' })),
}));

vi.mock('firebase-admin/auth', () => {
  const err = (code: string) => Object.assign(new Error(code), { code });
  return {
    getAuth: vi.fn(() => ({
      verifyIdToken: async (token: string, checkRevoked?: boolean) => {
        const u = H.personas[token];
        if (!u) throw err('auth/argument-error');
        const uid = u['uid'] as string;
        if (H.deleted.has(uid)) throw err('auth/user-not-found');
        if (checkRevoked && H.revoked.has(uid)) throw err('auth/id-token-revoked');
        return u;
      },
      deleteUser: async (uid: string) => {
        H.calls.push(uid);
        if (H.failNext) {
          H.failNext = false;
          throw err('auth/internal-error');
        }
        H.deleted.add(uid);
      },
      revokeRefreshTokens: async (uid: string) => {
        H.revoked.add(uid);
      },
      updateUser: async () => ({}),
    })),
  };
});

const RUN = H.RUN;
const fb = H;

const { closeDb, db } = await import('../db/client.js');
const { buildServer } = await import('../server.js');
const { updateMyProfile } = await import('../services/consumer_service.js');
const { assertFirebaseUidNotDeleted } = await import('../services/user_service.js');

const runIntegration = Boolean(process.env.RUN_INTEGRATION);
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

function firstRow<T>(res: unknown): T {
  return (res as unknown as T[])[0]!;
}

type UserRow = {
  id: string;
  firebase_uid: string;
  phone_e164: string | null;
  email: string | null;
  email_verified: boolean;
  display_name: string | null;
  interests: string[];
  deleted_at: string | null;
};

type BookingRow = {
  id: string;
  customer_user_id: string | null;
  customer_name: string | null;
  customer_contact: string | null;
  total_paise: string | number | null;
  status: string;
};

describe.skipIf(!runIntegration)('consumer account deletion (DELETE /v1/consumer/me)', () => {
  let app: FastifyInstance;
  let victimId: string;
  let flakyId: string;
  let bookingId: string;
  let publicThreadId: string;
  let supportIssueId: string;
  let notificationId: string;
  let orgTenantId: string;
  const VICTIM_UID = `fbuid_victim_ad_${RUN}`;
  const VICTIM_PHONE = `+9199${String(RUN).slice(-8)}`;

  const loadUser = async (id: string) =>
    firstRow<UserRow>(
      await db.execute<UserRow>(sql`SELECT * FROM users WHERE id = ${id}::uuid`),
    );

  const countUsersForUid = async (uid: string) =>
    Number(
      firstRow<{ n: string }>(
        await db.execute<{ n: string }>(
          sql`SELECT count(*)::text AS n FROM users WHERE firebase_uid = ${uid}`,
        ),
      ).n,
    );

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();

    // The consumer under test, with a full profile.
    const me = await app.inject({ method: 'GET', url: '/v1/consumer/me', headers: bearer('victim') });
    expect(me.statusCode).toBe(200);
    victimId = (me.json() as { profile: { id: string } }).profile.id;
    const patched = await app.inject({
      method: 'PATCH',
      url: '/v1/consumer/me',
      headers: bearer('victim'),
      payload: { displayName: 'Deleteme Kumar', interests: ['badminton'] },
    });
    expect(patched.statusCode).toBe(200);

    const flakyMe = await app.inject({ method: 'GET', url: '/v1/consumer/me', headers: bearer('flaky') });
    expect(flakyMe.statusCode).toBe(200);
    flakyId = (flakyMe.json() as { profile: { id: string } }).profile.id;

    // An org with a published event, so a public question thread can exist.
    const t = await app.inject({
      method: 'POST',
      url: '/v1/tenants',
      headers: bearer('owner'),
      payload: { name: `AD Sports ${RUN}`, slug: `ad-sports-${RUN}`, country: 'India', acceptTerms: true },
    });
    expect(t.statusCode).toBe(200);
    orgTenantId = (t.json() as { id: string }).id;
    const tenantId = orgTenantId;
    await db.execute(sql`UPDATE tenants SET status = 'active' WHERE id = ${tenantId}::uuid`);

    const eventId = firstRow<{ id: string }>(
      await db.execute<{ id: string }>(sql`
        INSERT INTO events (tenant_id, name, status, starts_at, ends_at, address_json, tz_name)
        VALUES (${tenantId}::uuid, 'AD Cup', 'published', now() + interval '7 days',
                now() + interval '7 days 2 hours', '{"city":"Pune"}'::jsonb, 'Asia/Kolkata')
        RETURNING id
      `),
    ).id;

    // The financial record that MUST survive deletion untouched.
    bookingId = firstRow<{ id: string }>(
      await db.execute<{ id: string }>(sql`
        INSERT INTO bookings (tenant_id, item_type, channel, payment_method, status,
                              customer_user_id, customer_name, customer_contact, total_paise, base_paise)
        VALUES (${tenantId}::uuid, 'event', 'circls', 'razorpay_route', 'confirmed',
                ${victimId}::uuid, 'Deleteme Kumar', ${VICTIM_PHONE}, 50000, 50000)
        RETURNING id
      `),
    ).id;

    // Behavioural telemetry.
    const activity = await app.inject({
      method: 'POST',
      url: '/v1/consumer/activity',
      headers: bearer('victim'),
      payload: {
        events: [
          { eventType: 'screen_view', clientTs: new Date().toISOString(), props: { route: '/explore' } },
          { eventType: 'search', clientTs: new Date().toISOString(), props: { query: 'tennis' } },
        ],
      },
    });
    expect(activity.statusCode).toBe(200);

    // A PUBLIC question thread authored by the victim — content must survive.
    const ask = await app.inject({
      method: 'POST',
      url: '/v1/consumer/questions',
      headers: bearer('victim'),
      payload: { subjectType: 'event', subjectId: eventId, visibility: 'public', body: 'Is parking free?' },
    });
    expect(ask.statusCode).toBe(200);
    publicThreadId = (ask.json() as { thread: { id: string } }).thread.id;

    // A support issue carrying free-text the user typed.
    supportIssueId = firstRow<{ id: string }>(
      await db.execute<{ id: string }>(sql`
        INSERT INTO support_issues (user_id, message, source, category, flow_answers)
        VALUES (${victimId}::uuid, 'Call me on +919812345678 about my refund', 'consumer_chatbot',
                'refund_request', '[{"question":"What went wrong?","answer":"charged twice"}]'::jsonb)
        RETURNING id
      `),
    ).id;

    // An outbound notification addressed to the victim's phone, still pending.
    notificationId = firstRow<{ id: string }>(
      await db.execute<{ id: string }>(sql`
        INSERT INTO notifications (tenant_id, user_id, channel, recipient, template_key, payload, status)
        VALUES (${tenantId}::uuid, ${victimId}::uuid, 'sms', ${VICTIM_PHONE}, 'booking_confirmed',
                '{"name":"Deleteme Kumar"}'::jsonb, 'pending')
        RETURNING id
      `),
    ).id;
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  beforeEach(() => {
    fb.calls.length = 0;
    fb.failNext = false;
    fb.revoked.clear();
  });

  it('rejects an unauthenticated delete with 401', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/v1/consumer/me' });
    expect(res.statusCode).toBe(401);
  });

  it('refuses to delete an account that also has partner-portal access (409)', async () => {
    // Creating a tenant makes this user its owner.
    const t = await app.inject({
      method: 'POST',
      url: '/v1/tenants',
      headers: bearer('partner'),
      payload: { name: `AD Partner ${RUN}`, slug: `ad-partner-${RUN}`, country: 'India', acceptTerms: true },
    });
    expect(t.statusCode).toBe(200);

    const res = await app.inject({ method: 'DELETE', url: '/v1/consumer/me', headers: bearer('partner') });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('partner_account');

    // Nothing was anonymised and Firebase was never touched — the guard runs first.
    const stillLive = await app.inject({ method: 'GET', url: '/v1/consumer/me', headers: bearer('partner') });
    expect(stillLive.statusCode).toBe(200);
    expect(fb.calls).toEqual([]);
  });

  /**
   * REGRESSION (review of PR #173, Critical 1). A Firebase teardown failure must
   * leave the caller ABLE to retry. The real `deleteFirebaseUser` runs here on
   * top of the fake backend, so if it ever revoked refresh tokens again, the
   * fake's checkRevoked path would reject the token, the retry would 401 at
   * requireAuth, and the Firebase account would be stranded with live PII.
   */
  it('returns 502 on a Firebase failure, then a retry on the SAME token succeeds', async () => {
    fb.failNext = true;
    const res = await app.inject({ method: 'DELETE', url: '/v1/consumer/me', headers: bearer('flaky') });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('firebase_delete_failed');

    // Nothing may have been revoked — that is what keeps the retry reachable.
    expect(fb.revoked.has(`fbuid_flaky_ad_${RUN}`)).toBe(false);

    // DB anonymisation already committed — the retry only has to redo Firebase.
    const row = await loadUser(flakyId);
    expect(row.phone_e164).toBeNull();
    expect(row.deleted_at).not.toBeNull();

    // The retry reaches the handler at all only because the token still verifies.
    const retry = await app.inject({ method: 'DELETE', url: '/v1/consumer/me', headers: bearer('flaky') });
    expect(retry.statusCode).toBe(204);
    expect(fb.calls).toEqual([`fbuid_flaky_ad_${RUN}`, `fbuid_flaky_ad_${RUN}`]);
  });

  it('returns 204 and anonymises the users row, keeping firebase_uid', async () => {
    const before = await loadUser(victimId);
    expect(before.phone_e164).toBe(VICTIM_PHONE);
    expect(before.display_name).toBe('Deleteme Kumar');

    const res = await app.inject({ method: 'DELETE', url: '/v1/consumer/me', headers: bearer('victim') });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');

    const after = await loadUser(victimId);
    expect(after.phone_e164).toBeNull();
    expect(after.email).toBeNull();
    expect(after.email_verified).toBe(false);
    expect(after.display_name).toBeNull();
    expect(after.interests).toEqual([]);
    expect(after.deleted_at).not.toBeNull();
    // The uid is RETAINED (no sentinel): it is what lets the login path
    // recognise this tombstone instead of minting a fresh row for the uid.
    expect(after.firebase_uid).toBe(VICTIM_UID);

    // Firebase account deleted after the commit, exactly once.
    expect(fb.calls).toEqual([VICTIM_UID]);
  });

  it('leaves the booking untouched (financial retention)', async () => {
    const b = firstRow<BookingRow>(
      await db.execute<BookingRow>(sql`SELECT * FROM bookings WHERE id = ${bookingId}::uuid`),
    );
    expect(b.customer_user_id).toBe(victimId);
    expect(b.customer_name).toBe('Deleteme Kumar');
    expect(b.customer_contact).toBe(VICTIM_PHONE);
    expect(Number(b.total_paise)).toBe(50000);
    expect(b.status).toBe('confirmed');
  });

  it('removes the consumer_activity rows', async () => {
    const rows = await db.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM consumer_activity WHERE user_id = ${victimId}::uuid`,
    );
    expect(Number(firstRow<{ n: string }>(rows).n)).toBe(0);
  });

  it('keeps public thread content but shows an anonymous author', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/consumer/questions/${publicThreadId}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      thread: { authorName: string };
      messages: { body: string; authorName: string }[];
    };
    expect(body.thread.authorName).toBe('Member');
    expect(body.messages[0]!.body).toBe('Is parking free?');
    expect(body.messages[0]!.authorName).toBe('Member');
  });

  it('redacts the support issue free-text', async () => {
    const row = firstRow<{ message: string; flow_answers: unknown }>(
      await db.execute<{ message: string; flow_answers: unknown }>(
        sql`SELECT message, flow_answers FROM support_issues WHERE id = ${supportIssueId}::uuid`,
      ),
    );
    expect(row.message).toBe('[deleted account]');
    expect(row.flow_answers).toBeNull();
  });

  it('redacts the notification recipient and cancels pending sends', async () => {
    const row = firstRow<{ recipient: string; status: string; payload: unknown }>(
      await db.execute<{ recipient: string; status: string; payload: unknown }>(
        sql`SELECT recipient, status, payload FROM notifications WHERE id = ${notificationId}::uuid`,
      ),
    );
    expect(row.recipient).toBe('[deleted account]');
    expect(row.status).toBe('skipped');
    expect(row.payload).toEqual({});
  });

  /**
   * REGRESSION (review of PR #173, Important 3). `bookings.customer_contact` is
   * RETAINED for financial reasons and is preferred over the (anonymised) users
   * join, so a later venue-side cancellation would otherwise text someone who
   * deleted their account.
   */
  it('never contacts a deleted account about a retained booking', async () => {
    const { notifyBookingCancelled } = await import('../services/notification_service.js');
    await notifyBookingCancelled(bookingId);
    const rows = await db.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM notifications
           WHERE payload->>'bookingId' = ${bookingId} AND recipient <> '[deleted account]'`,
    );
    expect(Number(firstRow<{ n: string }>(rows).n)).toBe(0);
  });

  /**
   * REGRESSION (review of PR #173, Important 2). Any authenticated request in
   * the window between the deletion committing and the Firebase account going
   * away used to re-mint the users row straight from the token's phone claim,
   * silently undoing the deletion. It must now be refused instead.
   */
  it('refuses a still-valid token for a deleted account instead of re-minting the row', async () => {
    // Model the window: the DB is a tombstone but the Firebase account lingers.
    fb.deleted.delete(VICTIM_UID);

    for (const url of ['/v1/consumer/me', '/v1/me']) {
      const res = await app.inject({ method: 'GET', url, headers: bearer('victim') });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('account_deleted');
    }
    const login = await app.inject({ method: 'POST', url: '/v1/me/login', headers: bearer('victim') });
    expect(login.statusCode).toBe(401);

    // Still exactly one row for the uid — the tombstone — and it is still empty.
    expect(await countUsersForUid(VICTIM_UID)).toBe(1);
    expect((await loadUser(victimId)).phone_e164).toBeNull();

    fb.deleted.add(VICTIM_UID);
  });

  /**
   * REGRESSION (review of PR #173, Important 4). A PATCH whose `currentUser`
   * resolved just before the deletion committed must not write the profile back
   * onto the tombstone. Called at the service layer because the route's own auth
   * now rejects the token before it gets this far.
   */
  it('refuses an in-flight profile update racing the deletion', async () => {
    await expect(updateMyProfile(victimId, { displayName: 'Back Again' })).rejects.toMatchObject({
      code: 'account_deleted',
    });
    const row = await loadUser(victimId);
    expect(row.display_name).toBeNull();
  });

  it('rejects a replayed token once the Firebase account is really gone', async () => {
    // Production truth: teardown succeeded, so the token no longer verifies and
    // the request dies at requireAuth. The point is that it is never a 500, and
    // that no row is resurrected.
    const res = await app.inject({ method: 'DELETE', url: '/v1/consumer/me', headers: bearer('victim') });
    expect(res.statusCode).toBe(401);
    expect(await countUsersForUid(VICTIM_UID)).toBe(1);
  });

  /**
   * REGRESSION (re-review of PR #173, NEW-1). The tombstone guard must match on
   * `deleted_at IS NOT NULL`, not on the uid alone. Callers run it after their
   * own live-row lookup missed, but that window is not exclusive: two concurrent
   * first-sight requests are routine (the app fires POST /v1/me/login
   * fire-and-forget while GET /v1/consumer/me races it), and a uid-only match
   * would see the winner's LIVE row and 401 a brand-new user. Asserted directly
   * rather than by racing requests, because the interleaving that triggers it is
   * too narrow to reproduce reliably — this pins the predicate itself.
   */
  it('does not mistake a LIVE row for a tombstone', async () => {
    await expect(assertFirebaseUidNotDeleted(`fbuid_owner_ad_${RUN}`)).resolves.toBeUndefined();
    // ...while a real tombstone is still refused.
    await expect(assertFirebaseUidNotDeleted(VICTIM_UID)).rejects.toMatchObject({
      code: 'account_deleted',
    });
  });

  it('serves concurrent first-sight sign-ins without 401ing the loser', async () => {
    const [a, b] = await Promise.all([
      app.inject({ method: 'GET', url: '/v1/consumer/me', headers: bearer('resignup') }),
      app.inject({ method: 'POST', url: '/v1/me/login', headers: bearer('resignup') }),
    ]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(204);
  });

  /**
   * REGRESSION (review of PR #173, Important 2 — second call site). Accepting a
   * team invitation is the OTHER path that resolves a Firebase uid to a users
   * row and inserts one if it is missing. Uniqueness on firebase_uid is now
   * live-only, so without its own tombstone guard this insert would happily mint
   * a legal SECOND live row for a deleted uid — and that row would let the
   * deleted account straight back in everywhere.
   */
  it('refuses a deleted account trying to walk back in via an invitation', async () => {
    const inviteeUid = `fbuid_invitee_ad_${RUN}`;
    const inviteeEmail = `invitee_ad_${RUN}@x.com`;

    // The invitee signs in once (live row), then deletes their account.
    const signIn = await app.inject({ method: 'GET', url: '/v1/consumer/me', headers: bearer('invitee') });
    expect(signIn.statusCode).toBe(200);
    const del = await app.inject({ method: 'DELETE', url: '/v1/consumer/me', headers: bearer('invitee') });
    expect(del.statusCode).toBe(204);

    // An org invites that same address.
    const invite = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${orgTenantId}/invitations`,
      headers: bearer('owner'),
      payload: { email: inviteeEmail, role: 'staff' },
    });
    expect(invite.statusCode).toBe(201);
    const inviteToken = (invite.json() as { token: string }).token;

    // Model the window where the Firebase account outlives the DB tombstone, so
    // the token still verifies and the request actually reaches acceptInvitation.
    fb.deleted.delete(inviteeUid);

    const accept = await app.inject({
      method: 'POST',
      url: `/v1/invitations/${inviteToken}/accept`,
      payload: { firebaseIdToken: 'invitee' },
    });
    expect(accept.statusCode).toBe(401);
    expect(accept.json().error.code).toBe('account_deleted');

    // No second live row was minted, and the tombstone is still the only row.
    expect(await countUsersForUid(inviteeUid)).toBe(1);
    const live = await db.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM users
           WHERE firebase_uid = ${inviteeUid} AND deleted_at IS NULL`,
    );
    expect(Number(firstRow<{ n: string }>(live).n)).toBe(0);

    fb.deleted.add(inviteeUid);
  });

  it('re-signup with the same phone creates a fresh user, never resurrecting the old one', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/consumer/me', headers: bearer('resignup') });
    expect(res.statusCode).toBe(200);
    const profile = (res.json() as { profile: { id: string; displayName: string | null; interests: string[] } })
      .profile;
    expect(profile.id).not.toBe(victimId);
    expect(profile.displayName).toBeNull();
    expect(profile.interests).toEqual([]);

    // The deleted row stays deleted and keeps its real uid.
    const old = await loadUser(victimId);
    expect(old.deleted_at).not.toBeNull();
    expect(old.firebase_uid).toBe(VICTIM_UID);
  });
});
