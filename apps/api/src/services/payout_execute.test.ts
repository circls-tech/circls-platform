import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { closeDb, db, pingDb } = await import('../db/client.js');
const { sql } = await import('drizzle-orm');
const { executePayout, executePayoutItem } = await import('./payout_service.js');

const runIntegration = Boolean(process.env.RUN_INTEGRATION);

/**
 * Settling a payout line by line, and finishing what is left.
 *
 * The case that matters most here is the one that shipped broken: once any
 * line was paid the payout became `partially_paid`, and executePayout rejected
 * anything that was not `pending` — so a payout holding an `advance` line,
 * which no per-item control can reach, could never be completed at all.
 */
describe.skipIf(!runIntegration)('payout settlement', () => {
  let tenantId: string;
  /** payouts.paid_by_user_id is a real FK, so the actor has to exist. */
  let actorId: string;

  beforeAll(async () => {
    await pingDb();
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const [t] = (await db.execute<Record<string, unknown>>(sql`
      insert into tenants (name, slug, commission_bps)
      values (${`PayExec ${stamp}`}, ${`payexec-${stamp}`}, 1000) returning id
    `)) as unknown as Record<string, unknown>[];
    tenantId = t!['id'] as string;

    const [u] = (await db.execute<Record<string, unknown>>(sql`
      insert into users (firebase_uid, display_name)
      values (${`payexec-${stamp}`}, 'Payout Exec Test') returning id
    `)) as unknown as Record<string, unknown>[];
    actorId = u!['id'] as string;
  });

  afterAll(async () => {
    await closeDb();
  });

  /** A pending payout with the given lines, returning their ids in order. */
  async function makePayout(
    lines: { itemType: string; amount: number }[],
  ): Promise<{ payoutId: string; itemIds: string[] }> {
    const [po] = (await db.execute<Record<string, unknown>>(sql`
      insert into payouts (tenant_id, provider, amount_paise, currency, status,
                           period_start, period_end)
      values (${tenantId}::uuid, 'stub',
              ${lines.reduce((a, l) => a + l.amount, 0)}, 'INR', 'pending',
              now() - interval '14 days', now() - interval '7 days')
      returning id
    `)) as unknown as Record<string, unknown>[];
    const payoutId = po!['id'] as string;

    const itemIds: string[] = [];
    for (const l of lines) {
      const [row] = (await db.execute<Record<string, unknown>>(sql`
        insert into payout_items (payout_id, tenant_id, item_type, item_id, currency,
                                  amount_paise, status)
        values (${payoutId}::uuid, ${tenantId}::uuid, ${l.itemType}, null, 'INR',
                ${l.amount}, 'pending')
        returning id
      `)) as unknown as Record<string, unknown>[];
      itemIds.push(row!['id'] as string);
    }
    return { payoutId, itemIds };
  }

  async function statusOf(payoutId: string): Promise<string> {
    const [r] = (await db.execute<Record<string, unknown>>(sql`
      select status from payouts where id = ${payoutId}::uuid
    `)) as unknown as Record<string, unknown>[];
    return r!['status'] as string;
  }

  it('rolls a payout up to partially_paid when one of its lines is settled', async () => {
    const { payoutId, itemIds } = await makePayout([
      { itemType: 'event', amount: 50000 },
      { itemType: 'slot', amount: 30000 },
    ]);

    const res = await executePayoutItem({
      payoutItemId: itemIds[0]!, reference: 'REF-1', actorUserId: actorId,
    });
    expect(res.payoutStatus).toBe('partially_paid');
    expect(await statusOf(payoutId)).toBe('partially_paid');
  });

  it('finishes a partially paid payout rather than refusing it', async () => {
    // The regression: executePayout guarded on `status !== 'pending'`, so the
    // moment one line was settled the whole-payout action 409'd forever.
    const { payoutId, itemIds } = await makePayout([
      { itemType: 'event', amount: 50000 },
      { itemType: 'advance', amount: 20000 },
    ]);
    await executePayoutItem({
      payoutItemId: itemIds[0]!, reference: 'REF-2', actorUserId: actorId,
    });
    expect(await statusOf(payoutId)).toBe('partially_paid');

    const done = await executePayout({
      payoutId, reference: 'REF-3', actorUserId: actorId,
    });
    expect(done.status).toBe('paid');
    expect(await statusOf(payoutId)).toBe('paid');
  });

  it('settles the lines no per-item control can reach', async () => {
    // An `advance` line belongs to no event, plan or venue, so only the
    // whole-payout action can clear it. If that path refuses a partially paid
    // payout the line is stranded for good.
    const { payoutId, itemIds } = await makePayout([
      { itemType: 'membership', amount: 40000 },
      { itemType: 'advance', amount: 15000 },
      { itemType: 'unattributed', amount: 500 },
    ]);
    await executePayoutItem({
      payoutItemId: itemIds[0]!, reference: 'REF-4', actorUserId: actorId,
    });
    await executePayout({ payoutId, reference: 'REF-5', actorUserId: actorId });

    const [left] = (await db.execute<Record<string, unknown>>(sql`
      select count(*)::int as pending from payout_items
       where payout_id = ${payoutId}::uuid and status = 'pending'
    `)) as unknown as Record<string, unknown>[];
    expect(Number(left!['pending'])).toBe(0);
  });

  it('still refuses a payout that is already paid in full', async () => {
    const { payoutId } = await makePayout([{ itemType: 'event', amount: 50000 }]);
    await executePayout({ payoutId, reference: 'REF-6', actorUserId: actorId });
    await expect(
      executePayout({ payoutId, reference: 'REF-7', actorUserId: actorId }),
    ).rejects.toMatchObject({ code: 'payout_not_pending' });
  });

  it('refuses a line that has already been settled', async () => {
    const { itemIds } = await makePayout([{ itemType: 'event', amount: 50000 }]);
    await executePayoutItem({
      payoutItemId: itemIds[0]!, reference: 'REF-8', actorUserId: actorId,
    });
    await expect(
      executePayoutItem({ payoutItemId: itemIds[0]!, reference: 'REF-9', actorUserId: actorId }),
    ).rejects.toMatchObject({ code: 'payout_item_not_pending' });
  });
});
