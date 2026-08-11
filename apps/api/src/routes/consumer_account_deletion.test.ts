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
// RUN makes every identity unique per run so the suite is re-runnable against a
// persistent DB (deleted rows keep their user id forever).
const RUN = vi.hoisted(() => Date.now());

// The Firebase side is mocked: `deleteFirebaseUser` records its calls so the
// route's revoke+delete-after-commit ordering and its idempotency can be
// asserted, and `failNextFirebaseDelete` simulates the 502 path.
const fb = vi.hoisted(() => ({ calls: [] as string[], failNext: false }));

vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      victim: { uid: `fbuid_victim_ad_${RUN}`, phone_number: `+9199${String(RUN).slice(-8)}` },
      // Same phone as `victim`, brand-new Firebase uid: the re-signup case.
      resignup: { uid: `fbuid_resignup_ad_${RUN}`, phone_number: `+9199${String(RUN).slice(-8)}` },
      flaky: { uid: `fbuid_flaky_ad_${RUN}`, phone_number: `+9188${String(RUN).slice(-8)}` },
      owner: { uid: `fbuid_owner_ad_${RUN}`, email: `owner_ad_${RUN}@x.com`, email_verified: true },
    };
    const u = map[token];
    if (!u) throw new Error('bad token');
    return u;
  }),
  deleteFirebaseUser: vi.fn(async (uid: string) => {
    fb.calls.push(uid);
    if (fb.failNext) {
      fb.failNext = false;
      throw new Error('firebase unreachable');
    }
  }),
}));

const { closeDb, db } = await import('../db/client.js');
const { buildServer } = await import('../server.js');

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
  const VICTIM_PHONE = `+9199${String(RUN).slice(-8)}`;

  const loadUser = async (id: string) =>
    firstRow<UserRow>(
      await db.execute<UserRow>(sql`SELECT * FROM users WHERE id = ${id}::uuid`),
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
    const tenantId = (t.json() as { id: string }).id;
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
  });

  it('rejects an unauthenticated delete with 401', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/v1/consumer/me' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 502 and leaves the DB anonymised when Firebase deletion fails', async () => {
    fb.failNext = true;
    const res = await app.inject({ method: 'DELETE', url: '/v1/consumer/me', headers: bearer('flaky') });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('firebase_delete_failed');

    // DB anonymisation already committed — the retry only has to redo Firebase.
    const row = await loadUser(flakyId);
    expect(row.phone_e164).toBeNull();
    expect(row.deleted_at).not.toBeNull();

    // Retry succeeds and is a clean 204.
    const retry = await app.inject({ method: 'DELETE', url: '/v1/consumer/me', headers: bearer('flaky') });
    expect(retry.statusCode).toBe(204);
    expect(fb.calls).toEqual([`fbuid_flaky_ad_${RUN}`, `fbuid_flaky_ad_${RUN}`]);
  });

  it('returns 204 and anonymises the users row', async () => {
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
    // firebase_uid is NOT NULL + UNIQUE, so it is re-keyed to a sentinel rather
    // than nulled — the real uid must be gone.
    expect(after.firebase_uid).toBe(`deleted:${victimId}`);

    // Firebase account deleted after the commit, exactly once.
    expect(fb.calls).toEqual([`fbuid_victim_ad_${RUN}`]);
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

  it('is idempotent — a second delete on a cached token is still 204', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/v1/consumer/me', headers: bearer('victim') });
    expect(res.statusCode).toBe(204);
    // No new users row was minted for the already-deleted identity.
    const rows = await db.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM users WHERE firebase_uid = ${`fbuid_victim_ad_${RUN}`}`,
    );
    expect(Number(firstRow<{ n: string }>(rows).n)).toBe(0);
  });

  it('re-signup with the same phone creates a fresh user, never resurrecting the old one', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/consumer/me', headers: bearer('resignup') });
    expect(res.statusCode).toBe(200);
    const profile = (res.json() as { profile: { id: string; displayName: string | null; interests: string[] } })
      .profile;
    expect(profile.id).not.toBe(victimId);
    expect(profile.displayName).toBeNull();
    expect(profile.interests).toEqual([]);

    // The deleted row stays deleted and keeps its sentinel uid.
    const old = await loadUser(victimId);
    expect(old.deleted_at).not.toBeNull();
    expect(old.firebase_uid).toBe(`deleted:${victimId}`);
  });
});
