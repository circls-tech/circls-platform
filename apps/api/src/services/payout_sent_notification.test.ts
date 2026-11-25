import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db, pingDb } from '../db/client.js';
import { notifications } from '../db/schema/index.js';
import { renderEmail } from '../lib/notifications/email_designs/index.js';
import { __resetNotificationsForTesting } from '../lib/notifications/index.js';
import { payoutSentPayload } from './notification_payloads.js';
import { executePayout, executePayoutItem } from './payout_service.js';

const runIntegration = Boolean(process.env.RUN_INTEGRATION);

type Row = Record<string, unknown>;

/**
 * The org hears about every transfer an admin records: paying a whole payout
 * sends one email, and so does each line paid on its own — each with what that
 * transfer sent, its reference, and what is still to come.
 */
describe.skipIf(!runIntegration)('payout sent email', () => {
  let tenantId: string;
  let actorId: string;
  let venueId: string;
  /** Each payout needs its own week: (tenant, period) is unique. */
  let week = 0;

  beforeAll(async () => {
    await pingDb();
    __resetNotificationsForTesting();
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const [t] = (await db.execute<Row>(sql`
      insert into tenants (name, slug, contact_email)
      values (${`PaySent ${stamp}`}, ${`paysent-${stamp}`}, ${`payouts-${stamp}@org.test`}) returning id
    `)) as unknown as Row[];
    tenantId = t!['id'] as string;
    const [u] = (await db.execute<Row>(sql`
      insert into users (firebase_uid, display_name)
      values (${`paysent-${stamp}`}, 'Payout Sent Test') returning id
    `)) as unknown as Row[];
    actorId = u!['id'] as string;
    const [v] = (await db.execute<Row>(sql`
      insert into venues (tenant_id, name) values (${tenantId}::uuid, 'Sent Arena') returning id
    `)) as unknown as Row[];
    venueId = v!['id'] as string;
  });

  afterAll(async () => {
    await closeDb();
  });

  /** A pending payout for the next week (Mon 5 Oct 2026 onwards, UTC), with lines. */
  async function makePayout(
    lines: { itemType: string; itemId?: string; amount: number }[],
    total = lines.reduce((a, l) => a + l.amount, 0),
  ): Promise<{ payoutId: string; itemIds: string[] }> {
    const start = new Date(Date.UTC(2026, 9, 5) + week * 7 * 86_400_000);
    const end = new Date(start.getTime() + 7 * 86_400_000);
    week += 1;
    const [po] = (await db.execute<Row>(sql`
      insert into payouts (tenant_id, provider, amount_paise, currency, status, period_start, period_end)
      values (${tenantId}::uuid, 'stub', ${total}, 'INR', 'pending', ${start.toISOString()}, ${end.toISOString()})
      returning id
    `)) as unknown as Row[];
    const payoutId = po!['id'] as string;
    const itemIds: string[] = [];
    for (const l of lines) {
      const [row] = (await db.execute<Row>(sql`
        insert into payout_items (payout_id, tenant_id, item_type, item_id, currency, amount_paise, status)
        values (${payoutId}::uuid, ${tenantId}::uuid, ${l.itemType}, ${l.itemId ?? null}, 'INR', ${l.amount}, 'pending')
        returning id
      `)) as unknown as Row[];
      itemIds.push(row!['id'] as string);
    }
    return { payoutId, itemIds };
  }

  const sentFor = async (payoutId: string) =>
    db
      .select()
      .from(notifications)
      .where(
        sql`tenant_id = ${tenantId} and template_key = 'partner.payout_sent' and payload->>'payoutId' = ${payoutId}`,
      )
      .orderBy(notifications.createdAt, notifications.id);

  it('paying a whole payout emails the org once, with the amount, reference and lines', async () => {
    const { payoutId } = await makePayout([
      { itemType: 'slot', itemId: venueId, amount: 50000 },
      { itemType: 'event', amount: 30000 },
      { itemType: 'advance', amount: 2050 },
    ]);
    await executePayout({ payoutId, reference: 'UTR-WHOLE-1', actorUserId: actorId });

    const rows = await sentFor(payoutId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.channel).toBe('email');
    expect(rows[0]!.recipient).toMatch(/^payouts-.*@org\.test$/);
    const p = rows[0]!.payload as Record<string, unknown>;
    expect(p['amountText']).toBe('₹820.50');
    expect(p['periodLabel']).toMatch(/^\d+ \w{3} – \d+ \w{3}$/);
    expect(p['remainingText']).toBe('');
    expect(p['lines']).toEqual([
      { name: 'Sent Arena', sub: 'Venue bookings', amount: '₹500' },
      // A line whose item is gone (or never had one) falls back to its kind.
      { name: 'Event', sub: 'Event', amount: '₹300' },
      { name: 'Advance', sub: 'Paid early on sales still on hold', amount: '₹20.50' },
    ]);
    expect(p['rows']).toContainEqual({ label: 'Reference', value: 'UTR-WHOLE-1', mono: true });

    const email = renderEmail('partner.payout_sent', p);
    expect(email.subject).toBe(`Payout sent: ₹820.50 for ${p['periodLabel'] as string}`);
    expect(email.html).toContain('Sent Arena');
    expect(email.html).not.toContain('The rest is on its way');
    expect(email.text).toContain('Reference: UTR-WHOLE-1');
  });

  it('paying line by line sends one email per transfer, saying what is still to come', async () => {
    const { payoutId, itemIds } = await makePayout([
      { itemType: 'slot', itemId: venueId, amount: 60000 },
      { itemType: 'event', amount: 40000 },
    ]);

    await executePayoutItem({ payoutItemId: itemIds[0]!, reference: 'UTR-LINE-1', actorUserId: actorId });
    let rows = await sentFor(payoutId);
    expect(rows).toHaveLength(1);
    const first = rows[0]!.payload as Record<string, unknown>;
    expect(first['amountText']).toBe('₹600');
    expect(first['remainingText']).toBe('₹400');
    expect(first['rows']).toContainEqual({ label: 'Payout for the week', value: '₹1,000' });
    expect(renderEmail('partner.payout_sent', first).html).toContain('The rest is on its way');

    // Finishing the payout sends the rest, with its own reference.
    await executePayout({ payoutId, reference: 'UTR-LINE-2', actorUserId: actorId });
    rows = await sentFor(payoutId);
    expect(rows).toHaveLength(2);
    const second = rows[1]!.payload as Record<string, unknown>;
    expect(second['amountText']).toBe('₹400');
    expect(second['remainingText']).toBe('');
    expect(second['rows']).toContainEqual({ label: 'Sent earlier', value: '₹600' });
    expect(second['rows']).toContainEqual({ label: 'Reference', value: 'UTR-LINE-2', mono: true });
    expect(second['lines']).toEqual([{ name: 'Event', sub: 'Event', amount: '₹400' }]);
  });

  it('a payout from before payout lines existed is reported whole', async () => {
    const { payoutId } = await makePayout([], 125000);
    await executePayout({ payoutId, reference: 'UTR-OLD-1', actorUserId: actorId });
    const rows = await sentFor(payoutId);
    expect(rows).toHaveLength(1);
    const p = rows[0]!.payload as Record<string, unknown>;
    expect(p['amountText']).toBe('₹1,250');
    expect(p['lines']).toEqual([]);
  });

  it('sends nothing for a transfer that moves no money to the org', async () => {
    // A line that only takes back an earlier advance pays the org nothing.
    const { payoutId, itemIds } = await makePayout([
      { itemType: 'event', amount: 30000 },
      { itemType: 'advance', amount: -5000 },
    ]);
    expect(await payoutSentPayload(payoutId, [itemIds[1]!])).toBeNull();
    await executePayoutItem({ payoutItemId: itemIds[1]!, reference: 'UTR-NEG-1', actorUserId: actorId });
    expect(await sentFor(payoutId)).toHaveLength(0);
  });

  it('names at most eight lines, summing the rest', async () => {
    // Lines are unique per (payout, type, item), so each gets its own item id.
    const lines = Array.from({ length: 10 }, (_, i) => ({
      itemType: 'event',
      itemId: randomUUID(),
      amount: 1000 * (i + 1),
    }));
    const { payoutId, itemIds } = await makePayout(lines);
    const sent = await payoutSentPayload(payoutId, itemIds);
    const shown = sent!.payload['lines'] as Array<{ name: string; amount: string }>;
    expect(shown).toHaveLength(8);
    // Largest first; the last row holds the three smallest (₹10 + ₹20 + ₹30).
    expect(shown[0]!.amount).toBe('₹100');
    expect(shown[7]).toMatchObject({ name: '3 more', amount: '₹60' });
  });
});
