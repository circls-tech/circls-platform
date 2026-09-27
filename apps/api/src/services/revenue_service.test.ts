import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { closeDb, db, pingDb } = await import('../db/client.js');
const { sql } = await import('drizzle-orm');
const { getPlatformRevenue, getTenantItemRevenue } = await import('./revenue_service.js');

const runIntegration = Boolean(process.env.RUN_INTEGRATION);

/** A window wide enough to hold everything these fixtures create. */
const FROM = '2030-01-01T00:00:00.000Z';
const TO = '2030-02-01T00:00:00.000Z';
const AT = (day: number) => `2030-01-${String(day).padStart(2, '0')}T10:00:00.000Z`;

describe.skipIf(!runIntegration)('revenue_service', () => {
  let tenantId: string;
  let otherTenantId: string;
  let venueId: string;
  let eventId: string;
  let planId: string;

  async function insertBooking(opts: {
    tenant?: string;
    itemType: 'slot' | 'event' | 'membership';
    paymentMethod?: 'razorpay_route' | 'external' | 'free';
    venue?: string | null;
    itemData?: Record<string, string> | null;
    at: string;
  }): Promise<string> {
    const rows = await db.execute<Record<string, unknown>>(sql`
      insert into bookings (tenant_id, item_type, channel, payment_method, status,
                            venue_id, item_data, currency, created_at)
      values (${opts.tenant ?? tenantId}::uuid, ${opts.itemType}, 'circls',
              ${opts.paymentMethod ?? 'razorpay_route'}, 'confirmed',
              ${opts.venue ?? null}, ${JSON.stringify(opts.itemData ?? {})}::jsonb,
              'INR', ${opts.at}::timestamptz)
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
    at: string;
  }): Promise<void> {
    await db.execute(sql`
      insert into payments (booking_id, tenant_id, provider, amount_paise, settle_base_paise,
                            partner_commission_paise, currency, status, kind, created_at)
      values (${opts.booking}::uuid, ${opts.tenant ?? tenantId}::uuid, 'stub',
              ${opts.amount}, ${opts.base ?? null}, ${opts.commission ?? null},
              ${opts.currency ?? 'INR'}, ${opts.status ?? (opts.kind === 'charge' ? 'captured' : 'captured')},
              ${opts.kind}, ${opts.at}::timestamptz)
    `);
  }

  beforeAll(async () => {
    await pingDb();
    const [t] = (await db.execute<Record<string, unknown>>(sql`
      insert into tenants (name, slug, commission_bps)
      values (${`RevCo ${Date.now()}`}, ${`revco-${Date.now()}`}, 1000)
      returning id
    `)) as unknown as Record<string, unknown>[];
    tenantId = t!['id'] as string;

    const [o] = (await db.execute<Record<string, unknown>>(sql`
      insert into tenants (name, slug, commission_bps)
      values (${`OtherRev ${Date.now()}`}, ${`otherrev-${Date.now()}`}, 1000)
      returning id
    `)) as unknown as Record<string, unknown>[];
    otherTenantId = o!['id'] as string;

    const [v] = (await db.execute<Record<string, unknown>>(sql`
      insert into venues (tenant_id, name) values (${tenantId}::uuid, 'Rev Venue') returning id
    `)) as unknown as Record<string, unknown>[];
    venueId = v!['id'] as string;

    eventId = crypto.randomUUID();
    planId = crypto.randomUUID();
  });

  afterAll(async () => {
    await closeDb();
  });

  describe('platform revenue', () => {
    beforeAll(async () => {
      // An event seat: ₹1,000 paid, ₹900 settleable, ₹90 commission.
      const ev = await insertBooking({
        itemType: 'event',
        itemData: { eventId },
        at: AT(5),
      });
      await insertPayment({
        booking: ev,
        kind: 'charge',
        amount: 100000,
        base: 90000,
        commission: 9000,
        at: AT(5),
      });

      // A court: ₹500 paid, ₹450 settleable, ₹45 commission — later refunded
      // in full. The refund reverses the money but NOT the commission.
      const slot = await insertBooking({ itemType: 'slot', venue: venueId, at: AT(6) });
      await insertPayment({
        booking: slot,
        kind: 'charge',
        status: 'refunded',
        amount: 50000,
        base: 45000,
        commission: 4500,
        at: AT(6),
      });
      await insertPayment({
        booking: slot,
        kind: 'refund',
        amount: -50000,
        base: -45000,
        at: AT(7),
      });

      // A plan sold in dollars, so it must never be added to the rupees.
      const plan = await insertBooking({
        itemType: 'membership',
        itemData: { membershipId: planId },
        at: AT(8),
      });
      await insertPayment({
        booking: plan,
        kind: 'charge',
        amount: 2000,
        base: 1800,
        commission: 180,
        currency: 'USD',
        at: AT(8),
      });

      // None of these are money: a failed charge, one still pending, and a
      // booking the partner took at the desk.
      const failed = await insertBooking({ itemType: 'event', itemData: { eventId }, at: AT(9) });
      await insertPayment({ booking: failed, kind: 'charge', status: 'failed', amount: 77700, at: AT(9) });
      const pending = await insertBooking({ itemType: 'event', itemData: { eventId }, at: AT(9) });
      await insertPayment({ booking: pending, kind: 'charge', status: 'pending', amount: 66600, at: AT(9) });
      await insertBooking({ itemType: 'slot', paymentMethod: 'external', venue: venueId, at: AT(9) });

      // Another org's sale, to prove the platform total is a sum of tenants
      // and a tenant's own figures never leak.
      const foreign = await insertBooking({
        tenant: otherTenantId,
        itemType: 'event',
        itemData: { eventId: crypto.randomUUID() },
        at: AT(10),
      });
      await insertPayment({
        booking: foreign,
        tenant: otherTenantId,
        kind: 'charge',
        amount: 300000,
        base: 270000,
        commission: 27000,
        at: AT(10),
      });
    });

    async function slicesFor(from = FROM, to = TO) {
      const all = await getPlatformRevenue(from, to);
      return new Map(all.map((s) => [`${s.itemType}:${s.currency}`, s]));
    }

    it('splits gross and net by what was sold', async () => {
      const s = await slicesFor();
      expect(s.get('event:INR')).toMatchObject({
        grossPaise: 100000 + 300000, // both orgs' event sales
        netPaise: 90000 - 9000 + (270000 - 27000),
        commissionPaise: 9000 + 27000,
        refundsPaise: 0,
        bookings: 2,
      });
    });

    it('nets a refund out of gross but leaves its commission behind', async () => {
      // Matching payout reconciliation: partner_commission_paise is
      // snapshotted at charge time and never written back.
      const s = await slicesFor();
      expect(s.get('slot:INR')).toMatchObject({
        grossPaise: 0, // 50000 taken, 50000 given back
        netPaise: 45000 - 45000 - 4500, // the commission still stands
        commissionPaise: 4500,
        refundsPaise: 50000,
        bookings: 1,
      });
    });

    it('keeps each currency in its own slice', async () => {
      const s = await slicesFor();
      expect(s.get('membership:USD')).toMatchObject({
        grossPaise: 2000,
        netPaise: 1800 - 180,
        commissionPaise: 180,
      });
      expect(s.has('membership:INR')).toBe(false);
    });

    it('counts neither a failed charge, a pending one, nor a desk booking', async () => {
      const s = await slicesFor();
      // Only the one real event sale per org; the three non-money rows above
      // would have added 77700 + 66600 and a fourth booking.
      expect(s.get('event:INR')!.bookings).toBe(2);
      expect(s.get('slot:INR')!.bookings).toBe(1);
    });

    it('takes `from` inclusively and `to` exclusively', async () => {
      const onlyTheEvent = await getPlatformRevenue(AT(5), AT(6));
      expect(onlyTheEvent.map((x) => x.itemType)).toEqual(['event']);
      expect(onlyTheEvent[0]!.grossPaise).toBe(100000);

      // The charge on the 6th and its refund on the 7th, separated.
      const chargeOnly = await getPlatformRevenue(AT(6), AT(7));
      expect(chargeOnly.find((x) => x.itemType === 'slot')!.grossPaise).toBe(50000);
    });

    it('dates a refund when it was made, not when the sale was', async () => {
      const refundDay = await getPlatformRevenue(AT(7), AT(8));
      const slot = refundDay.find((x) => x.itemType === 'slot')!;
      expect(slot.grossPaise).toBe(-50000);
      expect(slot.refundsPaise).toBe(50000);
      expect(slot.bookings).toBe(0); // a refund is not a sale
    });
  });

  describe('per-tenant, grouped by the thing sold', () => {
    it('groups events by their id and excludes other orgs', async () => {
      const items = await getTenantItemRevenue(tenantId, 'event', FROM, TO);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        itemId: eventId,
        grossPaise: 100000,
        netPaise: 90000 - 9000,
        bookings: 1,
      });
    });

    it('groups slot money by venue', async () => {
      const items = await getTenantItemRevenue(tenantId, 'venue', FROM, TO);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ itemId: venueId, grossPaise: 0, refundsPaise: 50000 });
    });

    it('groups memberships by plan, keeping the currency', async () => {
      const items = await getTenantItemRevenue(tenantId, 'membership', FROM, TO);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ itemId: planId, currency: 'USD', grossPaise: 2000 });
    });

    it("returns nothing for an org that sold nothing of that kind", async () => {
      expect(await getTenantItemRevenue(otherTenantId, 'venue', FROM, TO)).toEqual([]);
    });
  });

  describe('legacy rows', () => {
    it('falls back to the amount and the tenant rate when snapshots are null', async () => {
      // Pre-snapshot charges carry neither settle_base_paise nor
      // partner_commission_paise; payout reconciliation recomputes both, and
      // so must this or old money would read as commission-free.
      const [t] = (await db.execute<Record<string, unknown>>(sql`
        insert into tenants (name, slug, commission_bps)
        values (${`Legacy ${Date.now()}`}, ${`legacy-${Date.now()}`}, 2000)
        returning id
      `)) as unknown as Record<string, unknown>[];
      const legacyTenant = t!['id'] as string;

      const b = await insertBooking({
        tenant: legacyTenant,
        itemType: 'event',
        itemData: { eventId: crypto.randomUUID() },
        at: AT(20),
      });
      await insertPayment({
        booking: b,
        tenant: legacyTenant,
        kind: 'charge',
        amount: 100000,
        base: null,
        commission: null,
        at: AT(20),
      });

      const items = await getTenantItemRevenue(legacyTenant, 'event', AT(20), AT(21));
      expect(items[0]).toMatchObject({
        grossPaise: 100000,
        commissionPaise: 20000, // 100000 × 2000bps, from the tenant's rate
        netPaise: 80000,
      });
    });
  });
});
