import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { closeDb, db, pingDb } = await import('../db/client.js');
const { sql } = await import('drizzle-orm');
const { getTenantEarnings } = await import('./earnings_service.js');

const runIntegration = Boolean(process.env.RUN_INTEGRATION);

/**
 * A window this run alone occupies, the same trick revenue_service.test.ts
 * uses: a random century-scale offset rather than a clock reading, so two runs
 * a minute apart don't share a window and read each other's rows.
 */
const DAY = 24 * 3600 * 1000;
const RUN_BASE = Date.UTC(2200, 0, 1) + Math.floor(Math.random() * 500_000) * DAY;
const AT = (day: number) => new Date(RUN_BASE + day * DAY).toISOString();
const FROM = AT(0);
const TO = AT(60);

describe.skipIf(!runIntegration)('earnings_service', () => {
  let tenantId: string;
  let otherTenantId: string;
  let venueId: string;
  let eventId: string;
  let planId: string;

  async function insertBooking(opts: {
    tenant?: string;
    itemType: 'slot' | 'event' | 'membership';
    paymentMethod?: 'razorpay_route' | 'external' | 'free';
    status?: string;
    venue?: string | null;
    itemData?: Record<string, string> | null;
    totalPaise?: number | null;
    at: string;
  }): Promise<string> {
    const rows = await db.execute<Record<string, unknown>>(sql`
      insert into bookings (tenant_id, item_type, channel, payment_method, status,
                            venue_id, item_data, currency, total_paise, created_at)
      values (${opts.tenant ?? tenantId}::uuid, ${opts.itemType}, 'circls',
              ${opts.paymentMethod ?? 'razorpay_route'}, ${opts.status ?? 'confirmed'},
              ${opts.venue ?? null}, ${JSON.stringify(opts.itemData ?? {})}::jsonb,
              'INR', ${opts.totalPaise ?? null}, ${opts.at}::timestamptz)
      returning id
    `);
    return (rows as unknown as Record<string, unknown>[])[0]!['id'] as string;
  }

  async function insertPayment(opts: {
    booking: string;
    tenant?: string;
    kind: 'charge' | 'refund';
    status?: string;
    /** Signed as the ledger stores it: charges positive, refunds negative. */
    amount: number;
    /** Settleable base; refunds store it negated. Omit to leave NULL (legacy). */
    base?: number | null;
    commission?: number | null;
    currency?: string;
    /**
     * Whether this charge was ever going to settle to the partner. Charges
     * default to held — the normal case — because a refund is only deducted
     * when its charge was. Pass false for the late-success-after-cancellation
     * shape this service must NOT deduct.
     */
    held?: boolean;
    at: string;
  }): Promise<void> {
    const held = opts.kind === 'charge' && (opts.held ?? true);
    await db.execute(sql`
      insert into payments (booking_id, tenant_id, provider, amount_paise, settle_base_paise,
                            partner_commission_paise, currency, status, kind,
                            settlement_hold_until, created_at)
      values (${opts.booking}::uuid, ${opts.tenant ?? tenantId}::uuid, 'stub',
              ${opts.amount}, ${opts.base ?? null}, ${opts.commission ?? null},
              ${opts.currency ?? 'INR'}, ${opts.status ?? 'captured'}, ${opts.kind},
              ${held ? opts.at : null}::timestamptz, ${opts.at}::timestamptz)
    `);
  }

  beforeAll(async () => {
    await pingDb();
    const stamp = Date.now();
    const [t] = (await db.execute<Record<string, unknown>>(sql`
      insert into tenants (name, slug, commission_bps)
      values (${`EarnCo ${stamp}`}, ${`earnco-${stamp}`}, 1000) returning id
    `)) as unknown as Record<string, unknown>[];
    tenantId = t!['id'] as string;

    const [o] = (await db.execute<Record<string, unknown>>(sql`
      insert into tenants (name, slug, commission_bps)
      values (${`OtherEarn ${stamp}`}, ${`otherearn-${stamp}`}, 1000) returning id
    `)) as unknown as Record<string, unknown>[];
    otherTenantId = o!['id'] as string;

    const [v] = (await db.execute<Record<string, unknown>>(sql`
      insert into venues (tenant_id, name) values (${tenantId}::uuid, 'Earn Arena') returning id
    `)) as unknown as Record<string, unknown>[];
    venueId = v!['id'] as string;

    // Real event and plan rows, so the name/venue joins are exercised rather
    // than left resolving to null.
    const [ev] = (await db.execute<Record<string, unknown>>(sql`
      insert into events (tenant_id, venue_id, name, starts_at, ends_at)
      values (${tenantId}::uuid, ${venueId}::uuid, 'Finals Night',
              ${AT(5)}::timestamptz, ${AT(6)}::timestamptz)
      returning id
    `)) as unknown as Record<string, unknown>[];
    eventId = ev!['id'] as string;

    const [plan] = (await db.execute<Record<string, unknown>>(sql`
      insert into memberships (tenant_id, venue_id, name, duration_days)
      values (${tenantId}::uuid, ${venueId}::uuid, 'Gold Annual', 365)
      returning id
    `)) as unknown as Record<string, unknown>[];
    planId = plan!['id'] as string;

    // ── An event seat: ₹1,000 paid, ₹900 settleable, ₹90 commission → ₹810 net.
    const seat = await insertBooking({ itemType: 'event', itemData: { eventId }, venue: venueId, at: AT(5) });
    await insertPayment({ booking: seat, kind: 'charge', amount: 100000, base: 90000, commission: 9000, at: AT(5) });

    // ── A court: ₹500 paid, ₹450 settleable, ₹45 commission, then refunded in
    // full. The refund returns the ₹450 base but NOT the commission, so the
    // court nets −₹45 — which is the policy, not a bug.
    const court = await insertBooking({ itemType: 'slot', venue: venueId, at: AT(6) });
    await insertPayment({ booking: court, kind: 'charge', status: 'refunded', amount: 50000, base: 45000, commission: 4500, at: AT(6) });
    await insertPayment({ booking: court, kind: 'refund', amount: -50000, base: -45000, at: AT(7) });

    // ── A plan sold in dollars: $20 paid, $18 settleable, $1.80 commission.
    const gold = await insertBooking({ itemType: 'membership', itemData: { membershipId: planId }, venue: venueId, at: AT(8) });
    await insertPayment({ booking: gold, kind: 'charge', amount: 2000, base: 1800, commission: 180, currency: 'USD', at: AT(8) });

    // ── Not money: a failed charge and one still pending.
    const failed = await insertBooking({ itemType: 'event', itemData: { eventId }, at: AT(9) });
    await insertPayment({ booking: failed, kind: 'charge', status: 'failed', amount: 77700, at: AT(9) });
    const pending = await insertBooking({ itemType: 'event', itemData: { eventId }, at: AT(9) });
    await insertPayment({ booking: pending, kind: 'charge', status: 'pending', amount: 66600, at: AT(9) });

    // ── Desk cash: ₹700, taken by the partner directly. No payments row exists.
    await insertBooking({ itemType: 'slot', paymentMethod: 'external', venue: venueId, totalPaise: 70000, at: AT(9) });
    // A cancelled desk booking is not takings — there is no refund to record,
    // so the booking standing or not is the only signal there is.
    await insertBooking({ itemType: 'slot', paymentMethod: 'external', status: 'cancelled', venue: venueId, totalPaise: 999900, at: AT(9) });

    // ── Another organisation's sale, which must never appear.
    const foreign = await insertBooking({ tenant: otherTenantId, itemType: 'event', itemData: { eventId }, at: AT(10) });
    await insertPayment({ booking: foreign, tenant: otherTenantId, kind: 'charge', amount: 500000, base: 450000, commission: 45000, at: AT(10) });
  });

  afterAll(async () => {
    await closeDb();
  });

  it('reports net per stream, never gross', async () => {
    const e = await getTenantEarnings(tenantId, FROM, TO);

    const events = e.byStream.find((s) => s.stream === 'event' && s.currency === 'INR');
    // ₹900 base − ₹90 commission. NOT the ₹1,000 the customer paid.
    expect(events?.netPaise).toBe(81000);
    expect(events?.bookings).toBe(1);

    const venues = e.byStream.find((s) => s.stream === 'venue' && s.currency === 'INR');
    // Refunded in full, but the commission is not reversed.
    expect(venues?.netPaise).toBe(-4500);

    const plans = e.byStream.find((s) => s.stream === 'membership' && s.currency === 'USD');
    expect(plans?.netPaise).toBe(1620);
  });

  it('never returns a gross or commission figure to render', async () => {
    const e = await getTenantEarnings(tenantId, FROM, TO);
    const keys = new Set(Object.keys(e.items[0] ?? {}));
    for (const forbidden of ['grossPaise', 'commissionPaise', 'refundsPaise', 'feePaise']) {
      expect(keys.has(forbidden)).toBe(false);
    }
  });

  it('keeps currencies apart rather than summing paise into cents', async () => {
    const e = await getTenantEarnings(tenantId, FROM, TO);
    expect(e.total.map((t) => t.currency)).toEqual(['INR', 'USD']);
    // ₹810 − ₹45.
    expect(e.total.find((t) => t.currency === 'INR')?.netPaise).toBe(76500);
    expect(e.total.find((t) => t.currency === 'USD')?.netPaise).toBe(1620);
  });

  it('names each event, plan and venue, and the venue an event sits in', async () => {
    const e = await getTenantEarnings(tenantId, FROM, TO);
    const event = e.items.find((i) => i.stream === 'event');
    expect(event?.id).toBe(eventId);
    expect(event?.name).toBe('Finals Night');
    expect(event?.venueName).toBe('Earn Arena');

    expect(e.items.find((i) => i.stream === 'membership')?.name).toBe('Gold Annual');
    const venue = e.items.find((i) => i.stream === 'venue');
    expect(venue?.id).toBe(venueId);
    expect(venue?.name).toBe('Earn Arena');
  });

  it('reports desk takings separately, and only for bookings that stand', async () => {
    const e = await getTenantEarnings(tenantId, FROM, TO);
    const desk = e.desk.find((d) => d.currency === 'INR');
    // The ₹700 booking, not the cancelled ₹9,999 one.
    expect(desk?.amountMinor).toBe(70000);
    expect(desk?.bookings).toBe(1);
    // And it is in no net total.
    expect(e.total.find((t) => t.currency === 'INR')?.netPaise).toBe(76500);
  });

  it('never leaks another organisation s money', async () => {
    const e = await getTenantEarnings(otherTenantId, FROM, TO);
    expect(e.total.find((t) => t.currency === 'INR')?.netPaise).toBe(405000);
  });

  it('returns empty totals for a window with no sales', async () => {
    const e = await getTenantEarnings(tenantId, AT(40), AT(50));
    expect(e.total).toEqual([]);
    expect(e.items).toEqual([]);
    expect(e.desk).toEqual([]);
  });

  /**
   * The reason this service exists rather than reusing the admin read model.
   *
   * A payment that succeeds AFTER its booking was cancelled — a late UPI
   * success — is auto-refunded and never held for settlement, so its gross
   * never reaches a payout. Deducting its refund anyway would show the partner
   * LESS than the money that actually arrives. Payout reconciliation skips
   * such refunds; so must this.
   */
  it('does not deduct a refund whose charge was never going to be paid out', async () => {
    const stamp = Date.now();
    const [t] = (await db.execute<Record<string, unknown>>(sql`
      insert into tenants (name, slug, commission_bps)
      values (${`LateCo ${stamp}`}, ${`lateco-${stamp}`}, 1000) returning id
    `)) as unknown as Record<string, unknown>[];
    const lateTenant = t!['id'] as string;
    const [v] = (await db.execute<Record<string, unknown>>(sql`
      insert into venues (tenant_id, name) values (${lateTenant}::uuid, 'Late Venue') returning id
    `)) as unknown as Record<string, unknown>[];
    const lateVenue = v!['id'] as string;

    // A good sale: ₹1,000 base, ₹100 commission → ₹900 net.
    const good = await insertBooking({ tenant: lateTenant, itemType: 'slot', venue: lateVenue, at: AT(20) });
    await insertPayment({ booking: good, tenant: lateTenant, kind: 'charge', amount: 110000, base: 100000, commission: 10000, at: AT(20) });

    // A late success on an already-cancelled booking: never held, refunded at
    // once. The partner never had this sale.
    const late = await insertBooking({ tenant: lateTenant, itemType: 'slot', status: 'cancelled', venue: lateVenue, at: AT(21) });
    await insertPayment({
      booking: late, tenant: lateTenant, kind: 'charge', status: 'refunded',
      amount: 60000, base: 50000, commission: 5000, held: false, at: AT(21),
    });
    await insertPayment({ booking: late, tenant: lateTenant, kind: 'refund', amount: -60000, base: -50000, at: AT(21) });

    const e = await getTenantEarnings(lateTenant, FROM, TO);
    // Only the good sale: ₹1,000 base − ₹100 commission. The late charge and
    // its refund both drop out together, leaving the figure untouched — where
    // deducting the refund alone would have shown ₹400.
    expect(e.total.find((c) => c.currency === 'INR')?.netPaise).toBe(90000);
    // And the cancelled booking contributes no row at all, rather than a
    // confusing zero or negative line.
    expect(e.items).toHaveLength(1);
    expect(e.items[0]?.bookings).toBe(1);
  });
});
