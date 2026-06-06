/**
 * Admin out-of-policy refund route authz (M7).
 *
 * Verifies the capability-based authorization on
 * POST /v1/admin/payments/:paymentId/refund:
 *   - a partner tenant owner (has payments.refund) can refund their own
 *     tenant's payment;
 *   - a partner tenant manager (has payments.refund) can too;
 *   - a partner tenant staff / readonly (no payments.refund) get 403;
 *   - the platform-admin path still works.
 *
 * Integration-gated (RUN_INTEGRATION) like the other route tests; it self-skips
 * locally and runs in CI against a real Postgres.
 */
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      owner:    { uid: 'fbuid_ar_owner', email: 'ar_owner@x.com', email_verified: true },
      manager:  { uid: 'fbuid_ar_manager', email: 'ar_manager@x.com', email_verified: true },
      staff:    { uid: 'fbuid_ar_staff', email: 'ar_staff@x.com', email_verified: true },
      readonly: { uid: 'fbuid_ar_readonly', email: 'ar_readonly@x.com', email_verified: true },
      padmin:   { uid: 'fbuid_ar_padmin', email: 'ar_padmin@x.com', email_verified: true },
    };
    const u = map[token];
    if (!u) throw new Error('bad token');
    return u;
  }),
}));

const { closeDb, db } = await import('../db/client.js');
const { buildServer } = await import('../server.js');
const { bookings, payments } = await import('../db/schema/index.js');
const { __resetPlatformTenantCacheForTesting } = await import('../lib/authz/platform_tenant.js');

const runIntegration = Boolean(process.env.RUN_INTEGRATION);
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

describe.skipIf(!runIntegration)('admin refund route authz (M7)', () => {
  let app: FastifyInstance;
  const SUFFIX = Date.now();
  const PLATFORM_SLUG = `circls-internal-ar-${SUFFIX}`;
  let prevSlug: string | undefined;
  let platformTenantId: string;
  let tenantId: string;
  let paymentId: string;
  // user ids by role, resolved via /v1/me.
  const userIds: Record<string, string> = {};

  async function meId(token: string): Promise<string> {
    const res = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(token) });
    expect(res.statusCode).toBe(200);
    return (res.json() as { id: string }).id;
  }

  beforeAll(async () => {
    prevSlug = process.env['CIRCLS_INTERNAL_TENANT_SLUG'];
    process.env['CIRCLS_INTERNAL_TENANT_SLUG'] = PLATFORM_SLUG;
    __resetPlatformTenantCacheForTesting();

    app = await buildServer();
    await app.ready();

    // Provision all users.
    for (const role of ['owner', 'manager', 'staff', 'readonly', 'padmin']) {
      userIds[role] = await meId(role);
    }

    // Partner tenant — created via API by `owner`, who becomes its owner.
    const t = await app.inject({
      method: 'POST',
      url: '/v1/tenants',
      headers: bearer('owner'),
      payload: { name: 'Refund Co', slug: `refund-co-${SUFFIX}` },
    });
    expect(t.statusCode).toBe(200);
    tenantId = (t.json() as { id: string }).id;

    // Add manager / staff / readonly members directly.
    for (const role of ['manager', 'staff', 'readonly'] as const) {
      await db.execute(sql`
        INSERT INTO tenant_members (tenant_id, user_id, role)
        VALUES (${tenantId}::uuid, ${userIds[role]}::uuid, ${role})
      `);
    }

    // Platform tenant + a platform manager (padmin) for the admin path.
    const ptRows = await db.execute<{ id: string }>(sql`
      INSERT INTO tenants (name, slug, is_platform, status, subscription_status)
      VALUES ('Circls', ${PLATFORM_SLUG}, TRUE, 'active', 'trial')
      RETURNING id
    `);
    platformTenantId = (ptRows as unknown as { id: string }[])[0]!.id;
    await db.execute(sql`
      INSERT INTO tenant_members (tenant_id, user_id, role)
      VALUES (${platformTenantId}::uuid, ${userIds['padmin']}::uuid, 'manager')
    `);

    // Seed a captured charge to refund.
    const [b] = await db
      .insert(bookings)
      .values({
        tenantId,
        itemType: 'slot',
        channel: 'circls',
        paymentMethod: 'razorpay_route',
        status: 'confirmed',
        totalPaise: 50000,
        createdByUserId: userIds['owner']!,
      })
      .returning();
    const [p] = await db
      .insert(payments)
      .values({
        bookingId: b!.id,
        tenantId,
        provider: 'stub',
        providerPaymentId: null,
        amountPaise: 50000,
        currency: 'INR',
        status: 'captured',
        kind: 'charge',
      })
      .returning();
    paymentId = p!.id;
  });

  afterAll(async () => {
    await db.execute(sql`delete from payments where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from bookings where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenant_members where tenant_id = ${tenantId}::uuid`);
    await db.execute(sql`delete from tenants where id = ${tenantId}::uuid`);
    if (platformTenantId) {
      await db.execute(sql`delete from tenant_members where tenant_id = ${platformTenantId}::uuid`);
      await db.execute(sql`delete from tenants where id = ${platformTenantId}::uuid`);
    }
    process.env['CIRCLS_INTERNAL_TENANT_SLUG'] = prevSlug ?? 'circls-internal';
    __resetPlatformTenantCacheForTesting();
    await app.close();
    await closeDb();
  });

  const refund = (token: string, amountPaise: number) =>
    app.inject({
      method: 'POST',
      url: `/v1/admin/payments/${paymentId}/refund`,
      headers: bearer(token),
      payload: { amountPaise, reason: 'goodwill' },
    });

  it('partner owner (payments.refund) can refund their tenant payment', async () => {
    const res = await refund('owner', 1000);
    expect(res.statusCode).toBe(200);
  });

  it('partner manager (payments.refund) can refund their tenant payment', async () => {
    const res = await refund('manager', 1000);
    expect(res.statusCode).toBe(200);
  });

  it('partner staff (no payments.refund) is rejected with 403', async () => {
    const res = await refund('staff', 1000);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('admin_required');
  });

  it('partner readonly (no payments.refund) is rejected with 403', async () => {
    const res = await refund('readonly', 1000);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('admin_required');
  });

  it('platform admin (admin.payouts.execute) can refund any tenant payment', async () => {
    const res = await refund('padmin', 1000);
    expect(res.statusCode).toBe(200);
  });
});
