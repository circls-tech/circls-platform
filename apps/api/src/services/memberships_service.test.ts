import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Mock payments_service so the paid path doesn't depend on the Phase 12
// implementation. We INSERT a real payments row inside the mock so the
// downstream `user_memberships.payment_id` patch satisfies its FK.
vi.mock('./payments_service.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createPaymentOrder: vi.fn(
      async (input: {
        bookingId: string;
        tenantId: string;
        amountPaise: number;
      }) => {
        // Lazy import to avoid module-load cycle inside the mock factory.
        const { db } = await import('../db/client.js');
        const { payments } = await import('../db/schema/index.js');
        const [p] = await db
          .insert(payments)
          .values({
            bookingId: input.bookingId,
            tenantId: input.tenantId,
            provider: 'stub',
            amountPaise: input.amountPaise,
            currency: 'INR',
            status: 'pending',
            kind: 'charge',
            providerOrderId: `order_stub_${input.bookingId}`,
            metadata: { mocked: true },
          })
          .returning();
        return {
          paymentId: p!.id,
          providerOrderId: `order_stub_${input.bookingId}`,
        };
      },
    ),
  };
});

const { closeDb, db, pingDb } = await import('../db/client.js');
const { tenants, users } = await import('../db/schema/index.js');
const { eq, sql } = await import('drizzle-orm');
const {
  createMembership,
  listMembershipPurchases,
  listMembershipsForTenant,
  listUserMemberships,
  purchaseMembership,
  addExternalMember,
  updateMember,
  refundMember,
} = await import('./memberships_service.js');

const runIntegration = Boolean(process.env.RUN_INTEGRATION);

describe.skipIf(!runIntegration)('memberships_service', () => {
  let tenantId: string;
  let actorUserId: string;
  let buyerId: string;

  beforeAll(async () => {
    await pingDb();
    const [t] = await db
      .insert(tenants)
      .values({ name: 'MemCo', slug: `memco-${Date.now()}` })
      .returning();
    tenantId = t!.id;
    const [u1] = await db
      .insert(users)
      .values({
        firebaseUid: `mem-fb-actor-${Date.now()}`,
        email: `mem-actor-${Date.now()}@x.com`,
      })
      .returning();
    actorUserId = u1!.id;
    const [u2] = await db
      .insert(users)
      .values({
        firebaseUid: `mem-fb-buyer-${Date.now()}`,
        email: `mem-buyer-${Date.now()}@x.com`,
      })
      .returning();
    buyerId = u2!.id;
  });

  describe('members added by hand', () => {
    async function makePlan(capacity: number | null) {
      const plan = await createMembership({
        tenantId,
        actorUserId,
        name: `Hand-added ${Date.now()}${Math.round(capacity ?? -1)}`,
        pricePaise: 0,
        durationDays: 30,
        ...(capacity === null ? {} : { tiers: [{ name: 'Std', pricePaise: 50000, durationDays: 30, capacity }] }),
      });
      return plan;
    }

    it('records the member and never touches money', async () => {
      const plan = await makePlan(null);
      const { userMembershipId } = await addExternalMember(
        { tenantId, actorUserId },
        { membershipId: plan.id, name: 'Desk Signup Deepa', contact: '+919876500777' },
      );

      const rows = (await db.execute(sql`
        select user_id, payment_id, external_name, external_contact, created_by_user_id, status
          from user_memberships where id = ${userMembershipId}
      `)) as unknown as Array<Record<string, unknown>>;
      const r = rows[0]!;
      expect(r['user_id']).toBeNull();
      // The money guarantee: payouts read `payments`, and there is no payment.
      expect(r['payment_id']).toBeNull();
      expect(r['external_name']).toBe('Desk Signup Deepa');
      expect(r['external_contact']).toBe('+919876500777');
      expect(r['created_by_user_id']).toBe(actorUserId);
      expect(r['status']).toBe('active');
    });

    it('shows up in the buyers list, flagged as external', async () => {
      const plan = await makePlan(null);
      await addExternalMember(
        { tenantId, actorUserId },
        { membershipId: plan.id, name: 'Listed Lakshmi', contact: 'lakshmi@example.com' },
      );
      const rows = await listMembershipPurchases(tenantId, plan.id);
      const row = rows.find((x: { buyerName: string | null }) => x.buyerName === 'Listed Lakshmi');
      // A left join is required here: an inner join on users would silently
      // drop every hand-added member from the partner's own list.
      expect(row).toBeTruthy();
      expect(row!.external).toBe(true);
      expect(row!.buyerContact).toBe('lakshmi@example.com');
    });

    it('counts towards tier capacity like a purchase', async () => {
      const plan = await makePlan(1);
      const tierId = plan.tiers?.[0]?.id;
      await addExternalMember(
        { tenantId, actorUserId },
        { membershipId: plan.id, name: 'First In', ...(tierId ? { membershipTierId: tierId } : {}) },
      );
      await expect(
        addExternalMember(
          { tenantId, actorUserId },
          { membershipId: plan.id, name: 'One Too Many', ...(tierId ? { membershipTierId: tierId } : {}) },
        ),
      ).rejects.toMatchObject({ code: 'membership_tier_sold_out' });
    });

    it('rejects a blank name, so no member can be anonymous', async () => {
      const plan = await makePlan(null);
      await expect(
        addExternalMember({ tenantId, actorUserId }, { membershipId: plan.id, name: '   ' }),
      ).rejects.toMatchObject({ code: 'bad_request' });
    });

    it('refuses a plan belonging to another org', async () => {
      const [other] = await db
        .insert(tenants)
        .values({ name: 'OtherCo', slug: `otherco-${Date.now()}` })
        .returning();
      const plan = await makePlan(null);
      await expect(
        addExternalMember(
          { tenantId: other!.id, actorUserId },
          { membershipId: plan.id, name: 'Cross Tenant' },
        ),
      ).rejects.toMatchObject({ code: 'membership_not_found' });
      await db.execute(sql`delete from tenants where id = ${other!.id}`);
    });

    it('edits the validity window', async () => {
      const plan = await makePlan(null);
      const { userMembershipId } = await addExternalMember(
        { tenantId, actorUserId },
        { membershipId: plan.id, name: 'Extend Me' },
      );
      const newEnd = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000);
      await updateMember({ tenantId, actorUserId }, userMembershipId, plan.id, { endsAt: newEnd });

      const rows = (await db.execute(sql`
        select ends_at from user_memberships where id = ${userMembershipId}
      `)) as unknown as Array<{ ends_at: string }>;
      expect(new Date(rows[0]!.ends_at).getTime()).toBeCloseTo(newEnd.getTime(), -4);
    });

    it('refuses a window that ends before it starts', async () => {
      const plan = await makePlan(null);
      const { userMembershipId } = await addExternalMember(
        { tenantId, actorUserId },
        { membershipId: plan.id, name: 'Backwards' },
      );
      await expect(
        updateMember({ tenantId, actorUserId }, userMembershipId, plan.id, {
          endsAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
        }),
      ).rejects.toMatchObject({ code: 'bad_date_range' });
    });

    it('cancels a member, freeing their seat', async () => {
      const plan = await makePlan(1);
      const tierId = plan.tiers?.[0]?.id;
      const { userMembershipId } = await addExternalMember(
        { tenantId, actorUserId },
        { membershipId: plan.id, name: 'Leaving Leela', ...(tierId ? { membershipTierId: tierId } : {}) },
      );
      await updateMember({ tenantId, actorUserId }, userMembershipId, plan.id, { status: 'cancelled' });

      // Capacity counts non-cancelled holders, so the seat is available again.
      const { userMembershipId: replacement } = await addExternalMember(
        { tenantId, actorUserId },
        { membershipId: plan.id, name: 'Taking The Seat', ...(tierId ? { membershipTierId: tierId } : {}) },
      );
      expect(replacement).toBeTruthy();
    });

    it('refuses to reactivate a member whose seat has since been taken', async () => {
      const plan = await makePlan(1);
      const tierId = plan.tiers?.[0]?.id;
      const tier = tierId ? { membershipTierId: tierId } : {};

      const { userMembershipId } = await addExternalMember(
        { tenantId, actorUserId },
        { membershipId: plan.id, name: 'Original Holder', ...tier },
      );
      // Cancelling frees the seat...
      await updateMember({ tenantId, actorUserId }, userMembershipId, plan.id, {
        status: 'cancelled',
      });
      // ...and someone else takes it.
      await addExternalMember(
        { tenantId, actorUserId },
        { membershipId: plan.id, name: 'Replacement', ...tier },
      );

      // Reactivating the original would put a capacity-1 tier at two members.
      await expect(
        updateMember({ tenantId, actorUserId }, userMembershipId, plan.id, { status: 'active' }),
      ).rejects.toMatchObject({ code: 'membership_tier_sold_out' });
    });

    it('reactivates a member when their seat is still free', async () => {
      const plan = await makePlan(1);
      const tierId = plan.tiers?.[0]?.id;
      const tier = tierId ? { membershipTierId: tierId } : {};

      const { userMembershipId } = await addExternalMember(
        { tenantId, actorUserId },
        { membershipId: plan.id, name: 'Changed Their Mind', ...tier },
      );
      await updateMember({ tenantId, actorUserId }, userMembershipId, plan.id, {
        status: 'cancelled',
      });
      // Nobody took the seat, so they can have it back. The row must not block
      // itself when the count is taken.
      await updateMember({ tenantId, actorUserId }, userMembershipId, plan.id, {
        status: 'active',
      });

      const rows = (await db.execute(sql`
        select status from user_memberships where id = ${userMembershipId}
      `)) as unknown as Array<{ status: string }>;
      expect(rows[0]!.status).toBe('active');
    });

    it('refuses to refund a hand-added member — there is nothing to give back', async () => {
      const plan = await makePlan(null);
      const { userMembershipId } = await addExternalMember(
        { tenantId, actorUserId },
        { membershipId: plan.id, name: 'Paid You Directly' },
      );
      // No payment_id: circls never took this money, so offering a refund
      // would promise something it cannot deliver.
      await expect(
        refundMember({ tenantId, actorUserId }, userMembershipId, plan.id, 'test'),
      ).rejects.toMatchObject({ code: 'membership_not_refundable' });
    });

    it('refuses to refund a membership that is already cancelled', async () => {
      const plan = await makePlan(null);
      const { userMembershipId } = await addExternalMember(
        { tenantId, actorUserId },
        { membershipId: plan.id, name: 'Already Gone' },
      );
      await updateMember({ tenantId, actorUserId }, userMembershipId, plan.id, {
        status: 'cancelled',
      });
      await expect(
        refundMember({ tenantId, actorUserId }, userMembershipId, plan.id, 'test'),
      ).rejects.toMatchObject({ code: 'member_already_cancelled' });
    });

    it("refuses to refund another org's member", async () => {
      const [other] = await db
        .insert(tenants)
        .values({ name: 'OtherCo3', slug: `otherco3-${Date.now()}` })
        .returning();
      const plan = await makePlan(null);
      const { userMembershipId } = await addExternalMember(
        { tenantId, actorUserId },
        { membershipId: plan.id, name: 'Not Yours Either' },
      );
      await expect(
        refundMember({ tenantId: other!.id, actorUserId }, userMembershipId, plan.id, 'test'),
      ).rejects.toMatchObject({ code: 'member_not_found' });
      await db.execute(sql`delete from tenants where id = ${other!.id}`);
    });

    it('marks a hand-added member as not refundable in the list', async () => {
      const plan = await makePlan(null);
      await addExternalMember(
        { tenantId, actorUserId },
        { membershipId: plan.id, name: 'No Money Moved' },
      );
      const rows = await listMembershipPurchases(tenantId, plan.id);
      const row = rows.find((r: { buyerName: string | null }) => r.buyerName === 'No Money Moved');
      expect(row!.refundable).toBe(false);
    });

    it("refuses to touch another org's member", async () => {
      const [other] = await db
        .insert(tenants)
        .values({ name: 'OtherCo2', slug: `otherco2-${Date.now()}` })
        .returning();
      const plan = await makePlan(null);
      const { userMembershipId } = await addExternalMember(
        { tenantId, actorUserId },
        { membershipId: plan.id, name: 'Not Yours' },
      );
      await expect(
        updateMember({ tenantId: other!.id, actorUserId }, userMembershipId, plan.id, {
          status: 'cancelled',
        }),
      ).rejects.toMatchObject({ code: 'member_not_found' });
      await db.execute(sql`delete from tenants where id = ${other!.id}`);
    });
  });

  afterAll(async () => {
    await closeDb();
  });

  it('createMembership inserts a row and listMembershipsForTenant returns it', async () => {
    const m = await createMembership({
      tenantId,
      actorUserId,
      name: 'Gold',
      pricePaise: 0,
      durationDays: 30,
    });
    expect(m.tenantId).toBe(tenantId);
    // New memberships await Circls review (subproject B).
    expect(m.status).toBe('pending_review');
    const list = await listMembershipsForTenant(tenantId);
    expect(list.find((r) => r.id === m.id)).toBeTruthy();
  });

  it('purchaseMembership (free) activates instantly with no payment row', async () => {
    const m = await createMembership({
      tenantId,
      actorUserId,
      name: 'Free Trial',
      pricePaise: 0,
      durationDays: 7,
    });
    const result = await purchaseMembership({ membershipId: m.id, userId: buyerId });
    expect(result.userMembershipId).toBeTruthy();
    expect(result.paymentId).toBeUndefined();
    expect(result.orderId).toBeUndefined();

    const mine = await listUserMemberships(buyerId);
    const found = mine.find((r) => r.id === result.userMembershipId);
    expect(found).toBeTruthy();
    expect(found?.status).toBe('active');
    expect(found?.paymentId).toBeNull();
  });

  it('purchaseMembership (paid) succeeds — Circls is merchant, no KYC gate', async () => {
    const m = await createMembership({
      tenantId,
      actorUserId,
      name: 'Platinum',
      pricePaise: 299900,
      durationDays: 365,
    });
    const result = await purchaseMembership({ membershipId: m.id, userId: buyerId });
    expect(result.userMembershipId).toBeTruthy();
    expect(result.paymentId).toBeTruthy();
    expect(result.orderId).toMatch(/^order_stub_/);
  });

  it('createMembership with tiers exposes them and syncs the cheapest as the plan price', async () => {
    const m = await createMembership({
      tenantId,
      actorUserId,
      name: 'Tiered Pass',
      tiers: [
        { name: 'Gold', pricePaise: 200000, durationDays: 90, benefits: { items: [{ label: 'Priority booking' }] }, capacity: null },
        { name: 'Silver', pricePaise: 100000, durationDays: 30, benefits: { items: [] }, capacity: 1 },
      ],
    });
    expect(m.tiers).toHaveLength(2);
    // Legacy display fields mirror the cheapest tier.
    expect(m.pricePaise).toBe(100000);
    expect(m.durationDays).toBe(30);

    const list = await listMembershipsForTenant(tenantId);
    const found = list.find((r) => r.id === m.id);
    expect(found?.tiers.map((t) => t.name).sort()).toEqual(['Gold', 'Silver']);
  });

  it('purchaseMembership records the chosen tier and enforces tier capacity', async () => {
    const m = await createMembership({
      tenantId,
      actorUserId,
      name: 'Capped Plan',
      tiers: [{ name: 'Solo', pricePaise: 0, durationDays: 30, benefits: { items: [] }, capacity: 1 }],
    });
    const soloTier = m.tiers[0]!;

    const first = await purchaseMembership({
      membershipId: m.id,
      userId: buyerId,
      membershipTierId: soloTier.id,
    });
    expect(first.userMembershipId).toBeTruthy();
    const mine = await listUserMemberships(buyerId);
    expect(mine.find((r) => r.id === first.userMembershipId)?.tier?.name).toBe('Solo');

    // Capacity is 1 — the second buy is rejected.
    await expect(
      purchaseMembership({ membershipId: m.id, userId: actorUserId, membershipTierId: soloTier.id }),
    ).rejects.toMatchObject({ code: 'membership_tier_sold_out' });
  });
});
