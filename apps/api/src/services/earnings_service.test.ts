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
    /**
     * When the hold was released, which is the date a payout window picks a
     * charge up by. Omit to leave the charge under hold — money on its way but
     * not yet in any payout.
     */
    releasedAt?: string;
    /** An advance fronted against this charge, and when it was released. */
    advance?: { paise: number; releasedAt: string };
    at: string;
  }): Promise<void> {
    const held = opts.kind === 'charge' && (opts.held ?? true);
    await db.execute(sql`
      insert into payments (booking_id, tenant_id, provider, amount_paise, settle_base_paise,
                            partner_commission_paise, currency, status, kind,
                            settlement_hold_until, settlement_released_at,
                            advance_paise, advance_released_at, created_at)
      values (${opts.booking}::uuid, ${opts.tenant ?? tenantId}::uuid, 'stub',
              ${opts.amount}, ${opts.base ?? null}, ${opts.commission ?? null},
              ${opts.currency ?? 'INR'}, ${opts.status ?? 'captured'}, ${opts.kind},
              ${held ? opts.at : null}::timestamptz,
              ${opts.releasedAt ?? null}::timestamptz,
              ${opts.advance?.paise ?? null}, ${opts.advance?.releasedAt ?? null}::timestamptz,
              ${opts.at}::timestamptz)
    `);
  }

  /**
   * A payout covering [start, end) for one tenant, with the item lines that
   * carry its money.
   *
   * Lines are what paid-ness now lives on, so a payout without them settles
   * nothing — which is exactly how a pre-payout_items row behaves. `items`
   * names what the payout paid for; each line takes the payout's status.
   */
  async function insertPayout(opts: {
    tenant: string;
    start: string;
    end: string;
    status: 'paid' | 'pending';
    currency?: string;
    items?: { itemType: 'slot' | 'event' | 'membership'; itemId: string | null }[];
  }): Promise<void> {
    const [po] = (await db.execute<Record<string, unknown>>(sql`
      insert into payouts (tenant_id, provider, amount_paise, currency, status,
                           period_start, period_end)
      values (${opts.tenant}::uuid, 'stub', 0, ${opts.currency ?? 'INR'},
              ${opts.status}, ${opts.start}::timestamptz, ${opts.end}::timestamptz)
      returning id
    `)) as unknown as Record<string, unknown>[];
    const payoutId = po!['id'] as string;

    for (const it of opts.items ?? []) {
      await db.execute(sql`
        insert into payout_items (payout_id, tenant_id, item_type, item_id, currency,
                                  amount_paise, status, paid_at, paid_reference)
        values (${payoutId}::uuid, ${opts.tenant}::uuid, ${it.itemType},
                ${it.itemId}::uuid, ${opts.currency ?? 'INR'}, 0, ${opts.status},
                ${opts.status === 'paid' ? opts.end : null}::timestamptz,
                ${opts.status === 'paid' ? 'TEST-REF' : null})
      `);
    }
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
  /**
   * `paidPaise` answers "how much of this has actually reached me?". A payout
   * stores no per-payment breakdown, so the figure is re-derived from the
   * payout windows — which makes it worth pinning down hard.
   */
  describe('paid out', () => {
    let payTenant: string;
    let payVenue: string;

    /** A fresh tenant per case: payouts are tenant-wide and would cross-talk. */
    async function freshTenant(label: string): Promise<[string, string]> {
      const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      const [t] = (await db.execute<Record<string, unknown>>(sql`
        insert into tenants (name, slug, commission_bps)
        values (${`${label} ${stamp}`}, ${`${label.toLowerCase()}-${stamp}`}, 1000) returning id
      `)) as unknown as Record<string, unknown>[];
      const tid = t!['id'] as string;
      const [v] = (await db.execute<Record<string, unknown>>(sql`
        insert into venues (tenant_id, name) values (${tid}::uuid, 'Paid Venue') returning id
      `)) as unknown as Record<string, unknown>[];
      return [tid, v!['id'] as string];
    }

    beforeAll(async () => {
      [payTenant, payVenue] = await freshTenant('PaidCo');
    });

    it('reports nothing paid while the money is still under hold', async () => {
      const b = await insertBooking({ tenant: payTenant, itemType: 'slot', venue: payVenue, at: AT(30) });
      // Held but never released: on its way, in no payout yet.
      await insertPayment({
        booking: b, tenant: payTenant, kind: 'charge',
        amount: 110000, base: 100000, commission: 10000, at: AT(30),
      });

      const e = await getTenantEarnings(payTenant, FROM, TO);
      expect(e.total[0]?.netPaise).toBe(90000);
      expect(e.total[0]?.paidPaise).toBe(0);
    });

    it('counts a charge released inside a payout marked paid', async () => {
      const [tid, vid] = await freshTenant('PaidTwo');
      const b = await insertBooking({ tenant: tid, itemType: 'slot', venue: vid, at: AT(30) });
      await insertPayment({
        booking: b, tenant: tid, kind: 'charge', amount: 110000, base: 100000,
        commission: 10000, releasedAt: AT(33), at: AT(30),
      });
      await insertPayout({
        tenant: tid, start: AT(32), end: AT(34), status: 'paid',
        items: [{ itemType: 'slot', itemId: vid }],
      });

      const e = await getTenantEarnings(tid, FROM, TO);
      // Paid matches net exactly: the whole sale has been transferred.
      expect(e.total[0]?.netPaise).toBe(90000);
      expect(e.total[0]?.paidPaise).toBe(90000);
      expect(e.items[0]?.paidPaise).toBe(90000);
    });

    it('does not count a payout that is only reconciled, not yet paid', async () => {
      const [tid, vid] = await freshTenant('PendCo');
      const b = await insertBooking({ tenant: tid, itemType: 'slot', venue: vid, at: AT(30) });
      await insertPayment({
        booking: b, tenant: tid, kind: 'charge', amount: 110000, base: 100000,
        commission: 10000, releasedAt: AT(33), at: AT(30),
      });
      await insertPayout({
        tenant: tid, start: AT(32), end: AT(34), status: 'pending',
        items: [{ itemType: 'slot', itemId: vid }],
      });

      const e = await getTenantEarnings(tid, FROM, TO);
      // Money promised is not money sent.
      expect(e.total[0]?.netPaise).toBe(90000);
      expect(e.total[0]?.paidPaise).toBe(0);
    });

    it('pays out only the sales whose release fell inside the paid window', async () => {
      const [tid, vid] = await freshTenant('SplitCo');
      const early = await insertBooking({ tenant: tid, itemType: 'slot', venue: vid, at: AT(30) });
      await insertPayment({
        booking: early, tenant: tid, kind: 'charge', amount: 110000, base: 100000,
        commission: 10000, releasedAt: AT(33), at: AT(30),
      });
      const later = await insertBooking({ tenant: tid, itemType: 'slot', venue: vid, at: AT(36) });
      await insertPayment({
        booking: later, tenant: tid, kind: 'charge', amount: 110000, base: 100000,
        commission: 10000, releasedAt: AT(40), at: AT(36),
      });
      // Only the first week has been paid.
      await insertPayout({
        tenant: tid, start: AT(32), end: AT(34), status: 'paid',
        items: [{ itemType: 'slot', itemId: vid }],
      });

      const e = await getTenantEarnings(tid, FROM, TO);
      // Both sales are owed; one has landed. The gap is the point of the column.
      expect(e.total[0]?.netPaise).toBe(180000);
      expect(e.total[0]?.paidPaise).toBe(90000);
    });

    it('nets a refund off the paid figure when the payout carried it', async () => {
      const [tid, vid] = await freshTenant('RefCo');
      const b = await insertBooking({ tenant: tid, itemType: 'slot', venue: vid, at: AT(30) });
      await insertPayment({
        booking: b, tenant: tid, kind: 'charge', status: 'refunded', amount: 110000,
        base: 100000, commission: 10000, releasedAt: AT(33), at: AT(30),
      });
      // A refund is picked up by the week it was RAISED, not released.
      await insertPayment({ booking: b, tenant: tid, kind: 'refund', amount: -110000, base: -100000, at: AT(33) });
      await insertPayout({
        tenant: tid, start: AT(32), end: AT(34), status: 'paid',
        items: [{ itemType: 'slot', itemId: vid }],
      });

      const e = await getTenantEarnings(tid, FROM, TO);
      // Commission is never reversed, so a fully refunded sale leaves it
      // behind in both figures — they agree rather than drifting apart.
      expect(e.total[0]?.netPaise).toBe(-10000);
      expect(e.total[0]?.paidPaise).toBe(-10000);
    });

    it('never counts a charge that will never settle, even inside a paid window', async () => {
      const [tid, vid] = await freshTenant('NeverCo');
      const b = await insertBooking({ tenant: tid, itemType: 'slot', status: 'cancelled', venue: vid, at: AT(30) });
      // Late success on a cancelled booking: never held, so never in a payout —
      // a paid window covering its dates must not sweep it in.
      await insertPayment({
        booking: b, tenant: tid, kind: 'charge', status: 'refunded', amount: 60000,
        base: 50000, commission: 5000, held: false, at: AT(33),
      });
      await insertPayment({ booking: b, tenant: tid, kind: 'refund', amount: -60000, base: -50000, at: AT(33) });
      await insertPayout({
        tenant: tid, start: AT(32), end: AT(34), status: 'paid',
        items: [{ itemType: 'slot', itemId: vid }],
      });

      const e = await getTenantEarnings(tid, FROM, TO);
      expect(e.total).toHaveLength(0);
      expect(e.items).toHaveLength(0);
    });
    it('still credits a payout reconciled before per-item lines existed', async () => {
      // The migration regression this guards: a historical payout has no
      // payout_items rows, and matching on lines alone would make its money
      // stop counting as paid the moment per-item settlement shipped.
      const [tid, vid] = await freshTenant('LegacyCo');
      const b = await insertBooking({ tenant: tid, itemType: 'slot', venue: vid, at: AT(30) });
      await insertPayment({
        booking: b, tenant: tid, kind: 'charge', amount: 110000, base: 100000,
        commission: 10000, releasedAt: AT(33), at: AT(30),
      });
      // No `items`: a payout row with nothing under it, exactly as every
      // pre-migration payout looks.
      await insertPayout({ tenant: tid, start: AT(32), end: AT(34), status: 'paid' });

      const e = await getTenantEarnings(tid, FROM, TO);
      expect(e.total[0]?.paidPaise).toBe(90000);
    });

    it('lets lines govern once a payout has them, rather than its own status', async () => {
      // The other half: a payout WITH lines must be read through them, so a
      // week whose lines are still pending cannot read as fully paid just
      // because the payout row says so.
      const [tid, vid] = await freshTenant('GovernCo');
      const b = await insertBooking({ tenant: tid, itemType: 'slot', venue: vid, at: AT(30) });
      await insertPayment({
        booking: b, tenant: tid, kind: 'charge', amount: 110000, base: 100000,
        commission: 10000, releasedAt: AT(33), at: AT(30),
      });
      await insertPayout({
        tenant: tid, start: AT(32), end: AT(34), status: 'paid',
        items: [{ itemType: 'event', itemId: null }],   // a line, but not this sale's
      });

      const e = await getTenantEarnings(tid, FROM, TO);
      // The venue sale has no paid line of its own, and the payout is no
      // longer eligible for the legacy whole-payout reading.

    /**
     * Advances change WHEN a partner is paid, not how much. Reconciliation
     * pays one in the week it is released and deducts it from the week the
     * charge settles, so "how much has reached me" has to count the two
     * tranches separately — a filter that treats a charge as all-or-nothing
     * reports an advanced sale as entirely unpaid while its money is already
     * in the partner's account.
     */
    it('counts an advance that has gone out while the settlement has not', async () => {
      const [tid, vid] = await freshTenant('AdvCo');
      const b = await insertBooking({ tenant: tid, itemType: 'slot', venue: vid, at: AT(30) });
      await insertPayment({
        booking: b, tenant: tid, kind: 'charge', amount: 110000, base: 100000,
        commission: 10000, releasedAt: AT(40),
        advance: { paise: 30000, releasedAt: AT(33) }, at: AT(30),
      });
      // Only the advance's week has been paid; the settlement week has not.
      await insertPayout({
        tenant: tid, start: AT(32), end: AT(34), status: 'paid',
        items: [{ itemType: 'advance', itemId: null }],
      });

      const e = await getTenantEarnings(tid, FROM, TO);
      expect(e.total[0]?.netPaise).toBe(90000);
      expect(e.total[0]?.paidPaise).toBe(30000);
    });

    it('adds the settlement remainder without double-counting the advance', async () => {
      const [tid, vid] = await freshTenant('AdvTwo');
      const b = await insertBooking({ tenant: tid, itemType: 'slot', venue: vid, at: AT(30) });
      await insertPayment({
        booking: b, tenant: tid, kind: 'charge', amount: 110000, base: 100000,
        commission: 10000, releasedAt: AT(40),
        advance: { paise: 30000, releasedAt: AT(33) }, at: AT(30),
      });
      await insertPayout({
        tenant: tid, start: AT(32), end: AT(34), status: 'paid',
        items: [{ itemType: 'advance', itemId: null }],
      });
      // Now the settlement week is paid too. The partner has had the whole
      // net — \u20b9300 early and \u20b9600 on settlement — not \u20b9900 plus the advance again.
      await insertPayout({
        tenant: tid, start: AT(39), end: AT(41), status: 'paid',
        items: [{ itemType: 'slot', itemId: vid }],
      });

      const e = await getTenantEarnings(tid, FROM, TO);
      expect(e.total[0]?.paidPaise).toBe(90000);
      expect(e.total[0]?.paidPaise).toBe(e.total[0]?.netPaise);
    });

    it('ignores an advance that has not been released', async () => {
      const [tid, vid] = await freshTenant('AdvThree');
      const b = await insertBooking({ tenant: tid, itemType: 'slot', venue: vid, at: AT(30) });
      // advance_paise set but never released: nothing has been fronted.
      await insertPayment({
        booking: b, tenant: tid, kind: 'charge', amount: 110000, base: 100000,
        commission: 10000, releasedAt: AT(40), at: AT(30),
      });
      await insertPayout({
        tenant: tid, start: AT(32), end: AT(34), status: 'paid',
        items: [{ itemType: 'advance', itemId: null }],
      });

      const e = await getTenantEarnings(tid, FROM, TO);
      expect(e.total[0]?.paidPaise).toBe(0);
    });
  });
});
