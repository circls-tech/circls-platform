import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// "Block this person" on question threads (App Store guideline 1.2): the
// blocked user's public threads and replies stop being shown to the blocker
// only. Integration (RUN_INTEGRATION + a real Postgres).
const RUN = vi.hoisted(() => Date.now());
vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      owner: { uid: `fbuid_owner_qb_${RUN}`, email: `owner_qb_${RUN}@x.com`, email_verified: true },
      alice: { uid: `fbuid_alice_qb_${RUN}`, email: `alice_qb_${RUN}@x.com`, email_verified: true },
      bob: { uid: `fbuid_bob_qb_${RUN}`, email: `bob_qb_${RUN}@x.com`, email_verified: true },
      carol: { uid: `fbuid_carol_qb_${RUN}`, email: `carol_qb_${RUN}@x.com`, email_verified: true },
    };
    const u = map[token];
    if (!u) throw new Error('bad token');
    return u;
  }),
}));

const { closeDb, db } = await import('../db/client.js');
const { buildServer } = await import('../server.js');

const runIntegration = Boolean(process.env.RUN_INTEGRATION);
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

interface Detail {
  thread: { id: string };
  messages: { id: string; body: string }[];
}

describe.skipIf(!runIntegration)('question thread blocks', () => {
  let app: FastifyInstance;
  let tenantId: string;
  let eventId: string;
  let aliceThread: string;
  let bobThread: string;
  let carolReply: string;
  let ownerReply: string;

  const list = (who?: string) =>
    app.inject({
      method: 'GET',
      url: `/v1/consumer/questions?subjectType=event&subjectId=${eventId}`,
      ...(who ? { headers: bearer(who) } : {}),
    });
  const detail = (id: string, who?: string) =>
    app.inject({
      method: 'GET',
      url: `/v1/consumer/questions/${id}`,
      ...(who ? { headers: bearer(who) } : {}),
    });
  const block = (threadId: string, who: string, messageId?: string) =>
    app.inject({
      method: 'POST',
      url: `/v1/consumer/questions/${threadId}/block`,
      headers: bearer(who),
      payload: messageId ? { messageId } : {},
    });
  const ask = async (who: string, body: string) => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/consumer/questions',
      headers: bearer(who),
      payload: { subjectType: 'event', subjectId: eventId, visibility: 'public', body },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as Detail).thread.id;
  };

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
    for (const who of ['alice', 'bob', 'carol']) {
      await app.inject({ method: 'GET', url: '/v1/consumer/me', headers: bearer(who) });
    }
    const t = await app.inject({
      method: 'POST',
      url: '/v1/tenants',
      headers: bearer('owner'),
      payload: { name: `QB Sports ${RUN}`, slug: `qb-sports-${RUN}`, country: 'India', acceptTerms: true },
    });
    expect(t.statusCode).toBe(200);
    tenantId = (t.json() as { id: string }).id;
    await db.execute(sql`UPDATE tenants SET status = 'active' WHERE id = ${tenantId}::uuid`);
    const e = await db.execute<{ id: string }>(sql`
      INSERT INTO events (tenant_id, name, status, starts_at, ends_at, address_json, tz_name)
      VALUES (${tenantId}::uuid, 'QB Cup', 'published', now() + interval '7 days',
              now() + interval '7 days 2 hours', '{"city":"Pune"}'::jsonb, 'Asia/Kolkata')
      RETURNING id
    `);
    eventId = (e as unknown as { id: string }[])[0]!.id;

    aliceThread = await ask('alice', 'Is there parking at the QB Cup venue?');
    bobThread = await ask('bob', 'Are rackets available to rent at QB Cup?');
    const c = await app.inject({
      method: 'POST',
      url: `/v1/consumer/questions/${bobThread}/messages`,
      headers: bearer('carol'),
      payload: { body: 'Rude reply from carol' },
    });
    expect(c.statusCode).toBe(200);
    carolReply = (c.json() as { message: { id: string } }).message.id;
    const o = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/questions/${bobThread}/messages`,
      headers: bearer('owner'),
      payload: { body: 'Yes, at the front desk.' },
    });
    expect(o.statusCode).toBe(200);
    ownerReply = (o.json() as { message: { id: string } }).message.id;
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  it('blocking a thread author hides their threads from the blocker only', async () => {
    expect(((await list('bob')).json() as { rows: unknown[] }).rows).toHaveLength(2);

    expect((await block(aliceThread, 'bob')).statusCode).toBe(204);

    const ids = ((await list('bob')).json() as { rows: { id: string }[] }).rows.map((r) => r.id);
    expect(ids).toEqual([bobThread]);
    expect((await detail(aliceThread, 'bob')).statusCode).toBe(404);
    // Nobody else is affected.
    expect(((await list()).json() as { rows: unknown[] }).rows).toHaveLength(2);
    expect(((await list('carol')).json() as { rows: unknown[] }).rows).toHaveLength(2);
    expect((await detail(aliceThread)).statusCode).toBe(200);
  });

  it('blocking a replier hides their replies on the blocker’s own thread', async () => {
    expect((await block(bobThread, 'bob', carolReply)).statusCode).toBe(204);

    const mine = (await detail(bobThread, 'bob')).json() as Detail;
    expect(mine.messages.map((m) => m.id)).not.toContain(carolReply);
    expect(mine.messages.map((m) => m.id)).toContain(ownerReply);
    const anon = (await detail(bobThread)).json() as Detail;
    expect(anon.messages.map((m) => m.id)).toContain(carolReply);
  });

  it('is idempotent', async () => {
    const first = await block(aliceThread, 'carol');
    expect(first.statusCode, first.body).toBe(204);
    const again = await block(aliceThread, 'carol');
    expect(again.statusCode, again.body).toBe(204);
  });

  it('refuses yourself, organisers, strangers to the thread and anonymous callers', async () => {
    const self = await block(bobThread, 'bob');
    expect(self.statusCode).toBe(400);
    expect((self.json() as { error: { code: string } }).error.code).toBe('cannot_block_self');

    const staff = await block(bobThread, 'bob', ownerReply);
    expect(staff.statusCode).toBe(400);
    expect((staff.json() as { error: { code: string } }).error.code).toBe('cannot_block_staff');

    // A message from another thread is not this thread's.
    const elsewhere = await block(aliceThread, 'alice', carolReply);
    expect(elsewhere.statusCode).toBe(404);
    expect((elsewhere.json() as { error: { code: string } }).error.code).toBe(
      'question_message_not_found',
    );

    const anon = await app.inject({ method: 'POST', url: `/v1/consumer/questions/${bobThread}/block` });
    expect(anon.statusCode).toBe(401);
  });

  // Guideline 1.2's filter: objectionable text never gets posted.
  it('refuses objectionable text in asks and replies', async () => {
    const ask = await app.inject({
      method: 'POST',
      url: '/v1/consumer/questions',
      headers: bearer('carol'),
      payload: { subjectType: 'event', subjectId: eventId, visibility: 'public', body: 'what the fuck' },
    });
    expect(ask.statusCode).toBe(400);
    expect((ask.json() as { error: { code: string } }).error.code).toBe('objectionable_content');

    const reply = await app.inject({
      method: 'POST',
      url: `/v1/consumer/questions/${aliceThread}/messages`,
      headers: bearer('carol'),
      payload: { body: 'sh1t answer' },
    });
    expect(reply.statusCode).toBe(400);
    expect((reply.json() as { error: { code: string } }).error.code).toBe('objectionable_content');
  });
});
