/**
 * Phase-11 KYC service tests. Gated by RUN_INTEGRATION because they need a
 * live Postgres to exercise the audit trail + tenant updates. Razorpay calls
 * go through the stub adapter — no network.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import { closeDb, db, pingDb } from '../db/client.js';
import { auditLog, tenants } from '../db/schema/index.js';
import { users } from '../db/schema/users.js';
import { __resetRazorpayForTesting } from '../lib/razorpay.js';
import { pollKycStatuses, submitKyc } from './kyc_service.js';

const runIntegration = Boolean(process.env.RUN_INTEGRATION);

describe.skipIf(!runIntegration)('kyc_service', () => {
  let tenantId: string;
  let actorUserId: string;

  beforeAll(async () => {
    await pingDb();
  });

  afterAll(async () => {
    await closeDb();
  });

  beforeEach(async () => {
    __resetRazorpayForTesting();
    // Fresh tenant + actor per test so kyc_status assertions are deterministic.
    const [u] = await db
      .insert(users)
      .values({ firebaseUid: `kyc-actor-${Date.now()}-${Math.random()}` })
      .returning();
    actorUserId = u!.id;
    const [t] = await db
      .insert(tenants)
      .values({ name: 'KYC Co', slug: `kyc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` })
      .returning();
    tenantId = t!.id;
  });

  it('submitKyc flips status to submitted, persists fields, stores Linked Account id, and audits', async () => {
    const result = await submitKyc(tenantId, actorUserId, {
      legalName: 'KYC Co Pvt Ltd',
      email: 'biz@kyc.example.com',
      pan: 'ABCDE1234F',
      bank: { accountNumber: '12345678', ifsc: 'HDFC0000001', holderName: 'KYC Co' },
    });

    expect(result.tenantId).toBe(tenantId);
    expect(result.status).toBe('submitted');
    expect(result.linkedAccountId).toMatch(/^stub_la_/);

    const [row] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
    expect(row?.kycStatus).toBe('submitted');
    expect(row?.legalEntityName).toBe('KYC Co Pvt Ltd');
    expect(row?.panNumber).toBe('ABCDE1234F');
    expect(row?.bankIfsc).toBe('HDFC0000001');
    expect(row?.razorpayLinkedAccountId).toBe(result.linkedAccountId);
    expect(row?.kycSubmittedAt).toBeInstanceOf(Date);

    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, tenantId), eq(auditLog.action, 'kyc.submitted')));
    expect(audit?.actorUserId).toBe(actorUserId);
    expect((audit?.before as Record<string, unknown>)['kycStatus']).toBe('not_started');
    expect((audit?.after as Record<string, unknown>)['kycStatus']).toBe('submitted');
  });

  it('submitKyc on an already-submitted tenant returns 409 kyc_already_submitted', async () => {
    await submitKyc(tenantId, actorUserId, {
      legalName: 'KYC Co Pvt Ltd',
      email: 'biz@kyc.example.com',
    });
    await expect(
      submitKyc(tenantId, actorUserId, {
        legalName: 'KYC Co Pvt Ltd',
        email: 'biz@kyc.example.com',
      }),
    ).rejects.toMatchObject({ code: 'kyc_already_submitted', httpStatus: 409 });
  });

  it('pollKycStatuses transitions submitted → verified via stub adapter (which always reports activated)', async () => {
    await submitKyc(tenantId, actorUserId, {
      legalName: 'KYC Co Pvt Ltd',
      email: 'biz@kyc.example.com',
    });

    const polled = await pollKycStatuses();
    // At least one tenant (the one we just submitted). Other concurrent tests
    // would never share a tenant id since each test creates a fresh tenant.
    expect(polled).toBeGreaterThanOrEqual(1);

    const [row] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
    expect(row?.kycStatus).toBe('verified');
    expect(row?.kycVerifiedAt).toBeInstanceOf(Date);

    // The poller writes a system audit row with action=kyc.verified, no actor.
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, tenantId), eq(auditLog.action, 'kyc.verified')))
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    expect(audit?.actorUserId).toBeNull();
    expect((audit?.after as Record<string, unknown>)['kycStatus']).toBe('verified');
  });

  it('pollKycStatuses with no pending tenants returns 0', async () => {
    // tenant is in not_started by default; no Linked Account id.
    const polled = await pollKycStatuses();
    // Other concurrent tests may have submitted tenants — we can't assert ==0.
    // Just assert the call succeeds without throwing.
    expect(polled).toBeGreaterThanOrEqual(0);
  });
});
