import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Mock payments_service so the paid path doesn't depend on the Phase 12
// implementation. We INSERT a real payments row inside the mock so the
// downstream `user_memberships.payment_id` patch satisfies its FK.
vi.mock('./payments_service.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createRouteOrder: vi.fn(
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
const { eq } = await import('drizzle-orm');
const {
  createMembership,
  listMembershipsForTenant,
  listUserMemberships,
  purchaseMembership,
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
    expect(m.status).toBe('active');
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
});
