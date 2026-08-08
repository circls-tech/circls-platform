import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Post-login feedback prompts: past-event "how was it" review for registered
// consumers, random event-type MCQ for consumers with no bookings, and the
// phone_e164 snapshot on every stored answer.
// Integration (RUN_INTEGRATION + a real Postgres).
//
// RUN makes every identity unique per run so re-runs against the persistent
// sandbox DB never trip the one-per-user unique indexes.
const RUN = vi.hoisted(() => Date.now());
vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      // Phone-auth consumer who registered for the (now past) event.
      attendee: { uid: `fbuid_attendee_fb_${RUN}`, phone_number: `+9188${String(RUN).slice(-8)}` },
      // Phone-auth consumer with no bookings at all.
      newbie: { uid: `fbuid_newbie_fb_${RUN}`, phone_number: `+9199${String(RUN).slice(-8)}` },
    };
    const u = map[token];
    if (!u) throw new Error('bad token');
    return u;
  }),
}));

const { closeDb, db } = await import('../db/client.js');
const { buildServer } = await import('../server.js');
const { EVENT_TYPE_QUESTIONS } = await import('../services/feedback_service.js');

const runIntegration = Boolean(process.env.RUN_INTEGRATION);
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

function firstRow<T>(res: unknown): T {
  return (res as unknown as T[])[0]!;
}

describe.skipIf(!runIntegration)('post-login feedback (/v1/consumer/feedback)', () => {
  let app: FastifyInstance;
  let attendeeId: string;
  let attendeePhone: string;
  let pastEventId: string;
  let upcomingEventId: string;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();

    const me = await app.inject({ method: 'GET', url: '/v1/consumer/me', headers: bearer('attendee') });
    expect(me.statusCode).toBe(200);
    const profile = (me.json() as { profile: { id: string; phoneE164: string } }).profile;
    attendeeId = profile.id;
    attendeePhone = profile.phoneE164;
    await app.inject({ method: 'GET', url: '/v1/consumer/me', headers: bearer('newbie') });

    const tRows = await db.execute<{ id: string }>(sql`
      INSERT INTO tenants (name, slug, status, subscription_status)
      VALUES (${'FB Org ' + RUN}, ${'fb-org-' + RUN}, 'active', 'trial')
      RETURNING id
    `);
    const tenantId = firstRow<{ id: string }>(tRows).id;
    const vRows = await db.execute<{ id: string }>(sql`
      INSERT INTO venues (tenant_id, name, status) VALUES (${tenantId}::uuid, 'FB Venue', 'active')
      RETURNING id
    `);
    const venueId = firstRow<{ id: string }>(vRows).id;

    // One event that already ended (the review target) and one still upcoming
    // (its confirmed booking must NOT trigger a review prompt).
    const peRows = await db.execute<{ id: string }>(sql`
      INSERT INTO events (tenant_id, venue_id, name, status, starts_at, ends_at)
      VALUES (${tenantId}::uuid, ${venueId}::uuid, 'FB Past Cup', 'published', now() - interval '2 days', now() - interval '1 day')
      RETURNING id
    `);
    pastEventId = firstRow<{ id: string }>(peRows).id;
    const ueRows = await db.execute<{ id: string }>(sql`
      INSERT INTO events (tenant_id, venue_id, name, status, starts_at, ends_at)
      VALUES (${tenantId}::uuid, ${venueId}::uuid, 'FB Future Cup', 'published', now() + interval '7 days', now() + interval '7 days 2 hours')
      RETURNING id
    `);
    upcomingEventId = firstRow<{ id: string }>(ueRows).id;

    for (const eventId of [pastEventId, upcomingEventId]) {
      await db.execute(sql`
        INSERT INTO bookings (tenant_id, venue_id, item_type, channel, payment_method, status, item_data, customer_user_id, total_paise)
        VALUES (${tenantId}::uuid, ${venueId}::uuid, 'event', 'circls', 'free', 'confirmed',
                jsonb_build_object('eventId', ${eventId}::text), ${attendeeId}::uuid, 0)
      `);
    }
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  it('GET prompt without a token is 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/consumer/feedback/prompt' });
    expect(res.statusCode).toBe(401);
  });

  it('asks the attendee to review the past event (not the upcoming one)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/consumer/feedback/prompt',
      headers: bearer('attendee'),
    });
    expect(res.statusCode).toBe(200);
    const prompt = res.json().prompt;
    expect(prompt.kind).toBe('event_feedback');
    expect(prompt.event.id).toBe(pastEventId);
    expect(prompt.event.name).toBe('FB Past Cup');
    expect(prompt.event.venueName).toBe('FB Venue');
  });

  it('rejects a review of an event the user has no past registration for', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/consumer/feedback',
      headers: bearer('attendee'),
      payload: { kind: 'event_feedback', eventId: upcomingEventId, rating: 5 },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('feedback_event_not_eligible');
  });

  it('stores the review with the phone_e164 snapshot, then stops prompting', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/consumer/feedback',
      headers: bearer('attendee'),
      payload: { kind: 'event_feedback', eventId: pastEventId, rating: 4, comment: 'Great vibe' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().feedback.kind).toBe('event_feedback');

    const rows = await db.execute(sql`
      select phone_e164, rating, comment, booking_id from user_feedback
      where user_id = ${attendeeId}::uuid and kind = 'event_feedback' and event_id = ${pastEventId}::uuid
    `);
    expect(rows[0]).toMatchObject({ phone_e164: attendeePhone, rating: 4, comment: 'Great vibe' });
    expect((rows[0] as { booking_id: string | null }).booking_id).not.toBeNull();

    // Reviewed → nothing left to ask (has bookings, so no MCQ either).
    const prompt = await app.inject({
      method: 'GET',
      url: '/v1/consumer/feedback/prompt',
      headers: bearer('attendee'),
    });
    expect(prompt.json().prompt).toBeNull();
  });

  it('rejects a duplicate review with 409 feedback_exists', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/consumer/feedback',
      headers: bearer('attendee'),
      payload: { kind: 'event_feedback', eventId: pastEventId, rating: 1 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('feedback_exists');
  });

  it('serves a no-bookings consumer one MCQ from the event-type pool', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/consumer/feedback/prompt',
      headers: bearer('newbie'),
    });
    expect(res.statusCode).toBe(200);
    const prompt = res.json().prompt;
    expect(prompt.kind).toBe('event_type_preference');
    const pool = EVENT_TYPE_QUESTIONS.find((q) => q.key === prompt.question.key);
    expect(pool).toBeDefined();
    expect(prompt.question.options).toEqual(pool!.options);
  });

  it('rejects an answer that is not one of the offered options', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/consumer/feedback',
      headers: bearer('newbie'),
      payload: {
        kind: 'event_type_preference',
        questionKey: EVENT_TYPE_QUESTIONS[0]!.key,
        answer: 'Underwater basket weaving',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('feedback_invalid_answer');
  });

  it('stores the MCQ answer with question snapshot + phone, once per user', async () => {
    const question = EVENT_TYPE_QUESTIONS[0]!;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/consumer/feedback',
      headers: bearer('newbie'),
      payload: { kind: 'event_type_preference', questionKey: question.key, answer: question.options[1] },
    });
    expect(res.statusCode).toBe(200);

    const rows = await db.execute(sql`
      select f.phone_e164, f.question_key, f.question, f.answer
      from user_feedback f join users u on u.id = f.user_id
      where u.firebase_uid = ${'fbuid_newbie_fb_' + RUN} and f.kind = 'event_type_preference'
    `);
    expect(rows[0]).toMatchObject({
      question_key: question.key,
      question: question.question,
      answer: question.options[1],
    });
    expect((rows[0] as { phone_e164: string }).phone_e164).toMatch(/^\+91/);

    const dup = await app.inject({
      method: 'POST',
      url: '/v1/consumer/feedback',
      headers: bearer('newbie'),
      payload: { kind: 'event_type_preference', questionKey: question.key, answer: question.options[0] },
    });
    expect(dup.statusCode).toBe(409);

    const prompt = await app.inject({
      method: 'GET',
      url: '/v1/consumer/feedback/prompt',
      headers: bearer('newbie'),
    });
    expect(prompt.json().prompt).toBeNull();
  });
});
