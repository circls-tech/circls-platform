import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const runIntegration = Boolean(process.env.RUN_INTEGRATION);

const m = await import('./webhook_subscriptions_service.js');
const dbModule = await import('../db/client.js');
const schemaModule = await import('../db/schema/index.js');

describe.skipIf(!runIntegration)('webhook_subscriptions_service', () => {
  const { db, closeDb, pingDb } = dbModule;
  const { tenants } = schemaModule;
  let tenantId: string;

  beforeAll(async () => {
    await pingDb();
    const [t] = await db
      .insert(tenants)
      .values({ name: 'WebhookSvc', slug: `webhooksvc-${Date.now()}` })
      .returning();
    tenantId = t!.id;
  });

  afterAll(async () => {
    await db.execute(sql`delete from outbound_webhook_deliveries
      where subscription_id in (select id from webhook_subscriptions where tenant_id = ${tenantId})`);
    await db.execute(sql`delete from webhook_subscriptions where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
    await closeDb();
  });

  it('createSubscription returns a one-shot 32+ char secret', async () => {
    const { id, secret } = await m.createSubscription({
      tenantId,
      url: 'https://example.test/hooks',
      // Event the fan-out test doesn't use, so this row stays out of its assertions.
      events: ['kyc.approved'],
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(secret).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it('enqueueOutboundDeliveries fans out one row per matching active subscription', async () => {
    // Sub A: subscribes to booking.confirmed
    const a = await m.createSubscription({
      tenantId,
      url: 'https://a.example.test/hooks',
      events: ['booking.confirmed', 'booking.cancelled'],
    });
    // Sub B: subscribes only to payment.refunded — must NOT receive booking.confirmed
    const b = await m.createSubscription({
      tenantId,
      url: 'https://b.example.test/hooks',
      events: ['payment.refunded'],
    });
    // Sub C: matches event type but is disabled — must be skipped.
    const c = await m.createSubscription({
      tenantId,
      url: 'https://c.example.test/hooks',
      events: ['booking.confirmed'],
    });
    await db.execute(sql`update webhook_subscriptions set status = 'disabled' where id = ${c.id}`);

    const enqueued = await m.enqueueOutboundDeliveries(
      'booking.confirmed',
      { booking_id: 'b1', tenant_id: tenantId },
      tenantId,
    );
    expect(enqueued).toBe(1);

    // Verify exactly one delivery row for sub A.
    const rows = await db.execute<Record<string, unknown>>(sql`
      SELECT subscription_id, status, attempts FROM outbound_webhook_deliveries
      WHERE subscription_id IN (${a.id}, ${b.id}, ${c.id})
    `);
    const subIds = (rows as unknown as Record<string, unknown>[]).map((r) => r['subscription_id']);
    expect(subIds).toEqual([a.id]);
  });

  it('deleteSubscription cascades to deliveries', async () => {
    const sub = await m.createSubscription({
      tenantId,
      url: 'https://delete-me.example.test/hooks',
      events: ['booking.confirmed'],
    });
    await m.enqueueOutboundDeliveries('booking.confirmed', { x: 1 }, tenantId);
    await m.deleteSubscription(sub.id, tenantId);
    const rows = await db.execute<Record<string, unknown>>(sql`
      SELECT count(*)::int as n FROM outbound_webhook_deliveries WHERE subscription_id = ${sub.id}
    `);
    expect(Number((rows as unknown as Record<string, unknown>[])[0]?.['n'])).toBe(0);
  });

  it('deliverPendingOutboundWebhooks marks delivered on 2xx', async () => {
    // Spin a tiny test server so the delivery worker has a real target.
    const http = await import('node:http');
    const received: { headers: Record<string, string>; body: string }[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => { body += c.toString(); });
      req.on('end', () => {
        received.push({
          headers: req.headers as unknown as Record<string, string>,
          body,
        });
        res.statusCode = 200;
        res.end('ok');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no addr');
    const url = `http://127.0.0.1:${addr.port}/`;

    const sub = await m.createSubscription({ tenantId, url, events: ['booking.confirmed'] });
    await m.enqueueOutboundDeliveries('booking.confirmed', { booking_id: 'x' }, tenantId);

    const n = await m.deliverPendingOutboundWebhooks(2);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received[0]!.headers['x-circls-signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    const parsed = JSON.parse(received[0]!.body);
    expect(parsed.event_type).toBe('booking.confirmed');
    expect(parsed.payload.booking_id).toBe('x');

    // Row marked delivered.
    const rows = await db.execute<Record<string, unknown>>(sql`
      SELECT status, attempts FROM outbound_webhook_deliveries WHERE subscription_id = ${sub.id}
      ORDER BY created_at DESC LIMIT 1
    `);
    const last = (rows as unknown as Record<string, unknown>[])[0];
    expect(last?.['status']).toBe('delivered');
    expect(Number(last?.['attempts'])).toBe(1);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('deliverPendingOutboundWebhooks applies exponential backoff on non-2xx and gives up at max attempts', async () => {
    const http = await import('node:http');
    const server = http.createServer((_req, res) => {
      res.statusCode = 500;
      res.end('boom');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no addr');
    const url = `http://127.0.0.1:${addr.port}/`;

    const sub = await m.createSubscription({ tenantId, url, events: ['payment.refunded'] });
    await m.enqueueOutboundDeliveries('payment.refunded', { y: 2 }, tenantId);

    // First attempt: 500 → status stays pending, attempts=1, next_attempt_at pushed out.
    await m.deliverPendingOutboundWebhooks(1);
    const after1 = (await db.execute<Record<string, unknown>>(sql`
      SELECT status, attempts, next_attempt_at FROM outbound_webhook_deliveries
      WHERE subscription_id = ${sub.id}
      ORDER BY created_at DESC LIMIT 1
    `)) as unknown as Record<string, unknown>[];
    expect(after1[0]?.['status']).toBe('pending');
    expect(Number(after1[0]?.['attempts'])).toBe(1);
    // next_attempt_at should be set forward.
    const next1 = new Date(after1[0]?.['next_attempt_at'] as string).getTime();
    expect(next1).toBeGreaterThan(Date.now());

    // Yank backoff so we can iterate without sleeping.
    // Force next_attempt_at to "now" so the next sweep picks it up immediately.
    // Iterate up to the configured max to confirm the row ends up `failed`.
    const max = Number(process.env.WEBHOOK_DELIVERY_MAX_ATTEMPTS ?? 8);
    for (let i = 0; i < max + 1; i += 1) {
      await db.execute(sql`UPDATE outbound_webhook_deliveries
        SET next_attempt_at = now()
        WHERE subscription_id = ${sub.id} AND status = 'pending'`);
      await m.deliverPendingOutboundWebhooks(1);
    }
    const final = (await db.execute<Record<string, unknown>>(sql`
      SELECT status, attempts FROM outbound_webhook_deliveries
      WHERE subscription_id = ${sub.id}
      ORDER BY created_at DESC LIMIT 1
    `)) as unknown as Record<string, unknown>[];
    expect(final[0]?.['status']).toBe('failed');
    expect(Number(final[0]?.['attempts'])).toBeGreaterThanOrEqual(max);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
