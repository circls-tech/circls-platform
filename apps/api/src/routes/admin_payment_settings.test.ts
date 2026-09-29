/**
 * Admin payment settings (the INR gateway switch) — route authz + behaviour.
 * Read needs admin.payouts.read, changes need admin.payouts.execute; a partner
 * tenant's owner is not a platform admin at all.
 *
 * Integration-gated (RUN_INTEGRATION) like the other route tests.
 */
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      pmanager: { uid: 'fbuid_ps_pmanager', email: 'ps_pmanager@x.com', email_verified: true },
      preadonly: { uid: 'fbuid_ps_preadonly', email: 'ps_preadonly@x.com', email_verified: true },
      partner: { uid: 'fbuid_ps_partner', email: 'ps_partner@x.com', email_verified: true },
    };
    const u = map[token];
    if (!u) throw new Error('bad token');
    return u;
  }),
}));

const { closeDb, db } = await import('../db/client.js');
const { buildServer } = await import('../server.js');
const { platformSettings } = await import('../db/schema/index.js');
const { __resetPlatformTenantCacheForTesting } = await import('../lib/authz/platform_tenant.js');
const { __resetPaymentSettingsCacheForTesting, getInrPaymentGateway } = await import(
  '../services/payment_settings_service.js'
);
const { __resetInrFailoverForTesting, isCashfreeFailoverActive, recordCashfreeOutage } = await import(
  '../lib/inr_failover.js'
);

const runIntegration = Boolean(process.env.RUN_INTEGRATION);
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

describe.skipIf(!runIntegration)('admin payment settings routes', () => {
  let app: FastifyInstance;
  const SUFFIX = Date.now();
  const PLATFORM_SLUG = `circls-internal-ps-${SUFFIX}`;
  let prevSlug: string | undefined;
  let platformTenantId: string;
  let savedSetting: unknown;
  const userIds: Record<string, string> = {};

  beforeAll(async () => {
    prevSlug = process.env['CIRCLS_INTERNAL_TENANT_SLUG'];
    process.env['CIRCLS_INTERNAL_TENANT_SLUG'] = PLATFORM_SLUG;
    __resetPlatformTenantCacheForTesting();
    const [existing] = await db.select().from(platformSettings).where(sql`key = 'inr_payment_gateway'`);
    savedSetting = existing?.value;

    app = await buildServer();
    await app.ready();
    for (const who of ['pmanager', 'preadonly', 'partner']) {
      const res = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(who) });
      expect(res.statusCode).toBe(200);
      userIds[who] = (res.json() as { id: string }).id;
    }
    const pt = await db.execute<{ id: string }>(sql`
      INSERT INTO tenants (name, slug, is_platform, status, subscription_status)
      VALUES ('Circls', ${PLATFORM_SLUG}, TRUE, 'active', 'trial')
      RETURNING id
    `);
    platformTenantId = (pt as unknown as { id: string }[])[0]!.id;
    await db.execute(sql`
      INSERT INTO tenant_members (tenant_id, user_id, role) VALUES
        (${platformTenantId}::uuid, ${userIds['pmanager']}::uuid, 'manager'),
        (${platformTenantId}::uuid, ${userIds['preadonly']}::uuid, 'readonly')
    `);
  });

  afterAll(async () => {
    if (savedSetting === undefined) {
      await db.delete(platformSettings).where(sql`key = 'inr_payment_gateway'`);
    } else {
      await db
        .update(platformSettings)
        .set({ value: savedSetting, updatedByUserId: null })
        .where(sql`key = 'inr_payment_gateway'`);
    }
    __resetPaymentSettingsCacheForTesting();
    __resetInrFailoverForTesting();
    await db.execute(sql`delete from audit_log where tenant_id = ${platformTenantId}::uuid`);
    await db.execute(sql`delete from tenant_members where tenant_id = ${platformTenantId}::uuid`);
    await db.execute(sql`delete from tenants where id = ${platformTenantId}::uuid`);
    process.env['CIRCLS_INTERNAL_TENANT_SLUG'] = prevSlug ?? 'circls-internal';
    __resetPlatformTenantCacheForTesting();
    await app.close();
    await closeDb();
  });

  const put = (token: string, inrGateway: string) =>
    app.inject({
      method: 'PUT',
      url: '/v1/admin/payment-settings',
      headers: bearer(token),
      payload: { inrGateway },
    });

  it('a platform read-only member can see the settings but not change them', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/admin/payment-settings', headers: bearer('preadonly') });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      gateways: { razorpay: { mode: 'stub' }, cashfree: { mode: 'stub' } },
      failover: { active: false, threshold: 3, windowSec: 300, cooldownSec: 600 },
    });
    expect((await put('preadonly', 'cashfree')).statusCode).toBe(403);
  });

  it('a partner, not being a platform member, gets nothing', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/admin/payment-settings', headers: bearer('partner') });
    expect(res.statusCode).toBe(403);
  });

  it('a platform manager switches INR, and new orders follow at once', async () => {
    const res = await put('pmanager', 'cashfree');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ inrGateway: 'cashfree', source: 'admin' });
    expect(await getInrPaymentGateway()).toBe('cashfree');

    const back = await put('pmanager', 'razorpay');
    expect(back.json()).toMatchObject({ inrGateway: 'razorpay', source: 'admin' });
    expect(await getInrPaymentGateway()).toBe('razorpay');

    const audits = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from audit_log
      where tenant_id = ${platformTenantId}::uuid and action = 'platform.inr_gateway_changed'
    `);
    expect((audits as unknown as { n: number }[])[0]!.n).toBe(2);
  });

  it('rejects anything but razorpay or cashfree', async () => {
    expect((await put('pmanager', 'stripe')).statusCode).toBe(400);
  });

  it('a platform manager can end an automatic failover early', async () => {
    for (let i = 0; i < 3; i++) recordCashfreeOutage();
    expect(isCashfreeFailoverActive()).toBe(true);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/payment-settings/failover/clear',
      headers: bearer('pmanager'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ failover: { active: false } });
    expect(isCashfreeFailoverActive()).toBe(false);
  });
});
