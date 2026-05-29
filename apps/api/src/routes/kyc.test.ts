/**
 * Phase-11 KYC route smoke tests. Gated by RUN_INTEGRATION — they need a live
 * Postgres + a mocked Firebase verifier (the storage + razorpay adapters run
 * in their stub modes since no env vars are set in the test process).
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Unique-per-run UIDs so re-runs against the same dev DB don't collide on the
// users.firebase_uid unique index.
const RUN_SUFFIX = Date.now();
const OWNER_UID = `fbuid_kyc_owner_${RUN_SUFFIX}`;
const STRANGER_UID = `fbuid_kyc_stranger_${RUN_SUFFIX}`;

vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    if (token === 'owner') return { uid: OWNER_UID, email: `owner-${RUN_SUFFIX}@kyc.com` };
    if (token === 'stranger') return { uid: STRANGER_UID, email: `stranger-${RUN_SUFFIX}@kyc.com` };
    throw new Error('bad token');
  }),
}));

const { closeDb, db } = await import('../db/client.js');
const { tenants, tenantMembers, users } = await import('../db/schema/index.js');
const { buildServer } = await import('../server.js');
const { __resetRazorpayForTesting } = await import('../lib/razorpay.js');
const { __resetStorageForTesting } = await import('../lib/storage.js');

const runIntegration = Boolean(process.env.RUN_INTEGRATION);
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

describe.skipIf(!runIntegration)('kyc routes', () => {
  let app: FastifyInstance;
  let tenantId: string;
  let ownerUserId: string;

  beforeAll(async () => {
    __resetRazorpayForTesting();
    __resetStorageForTesting();
    app = await buildServer();
    await app.ready();

    // Seed owner user + tenant + membership directly so we don't depend on
    // /v1/tenants here (that's tested elsewhere).
    const [u] = await db
      .insert(users)
      .values({ firebaseUid: OWNER_UID, email: `owner-${RUN_SUFFIX}@kyc.com` })
      .returning();
    ownerUserId = u!.id;
    const [t] = await db
      .insert(tenants)
      .values({ name: 'Route KYC', slug: `route-kyc-${Date.now()}` })
      .returning();
    tenantId = t!.id;
    await db.insert(tenantMembers).values({
      userId: ownerUserId,
      tenantId,
      role: 'owner',
    });
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  it('GET /v1/tenants/:id/kyc returns the initial not_started state', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/kyc`,
      headers: bearer('owner'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('not_started');
    expect(res.json().razorpayLinkedAccountId).toBeNull();
  });

  it('non-member is 403 forbidden on GET', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/kyc`,
      headers: bearer('stranger'),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('tenant_forbidden');
  });

  it('POST /v1/tenants/:id/kyc rejects bad payload with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/kyc`,
      headers: bearer('owner'),
      payload: { legalName: '', email: 'not-an-email' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('bad_request');
  });

  it('full submit → status flips → presign + register doc → list → presigned download URL', async () => {
    const submit = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/kyc`,
      headers: bearer('owner'),
      payload: {
        legalName: 'Route KYC Pvt Ltd',
        email: 'biz@kyc.com',
        pan: 'ABCDE1234F',
        bank: { accountNumber: '12345678', ifsc: 'HDFC0000001', holderName: 'Route KYC' },
      },
    });
    expect(submit.statusCode).toBe(200);
    expect(submit.json().status).toBe('submitted');

    const status = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/kyc`,
      headers: bearer('owner'),
    });
    expect(status.json().status).toBe('submitted');

    // Re-submit must 409.
    const dup = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/kyc`,
      headers: bearer('owner'),
      payload: { legalName: 'Dup', email: 'biz@kyc.com' },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('kyc_already_submitted');

    // Presign upload.
    const presign = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/kyc/documents/presign`,
      headers: bearer('owner'),
      payload: { docType: 'pan', mimeType: 'application/pdf', sizeBytes: 1024 },
    });
    expect(presign.statusCode).toBe(200);
    const presignBody = presign.json();
    expect(presignBody.stub).toBe(true);
    expect(presignBody.uploadUrl).toMatch(/^stub:\/\//);
    expect(presignBody.storageKey).toMatch(new RegExp(`^kyc/${tenantId}/pan/`));

    // Register the doc.
    const register = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/kyc/documents`,
      headers: bearer('owner'),
      payload: {
        docType: 'pan',
        storageKey: presignBody.storageKey,
        mimeType: 'application/pdf',
        sizeBytes: 1024,
      },
    });
    expect(register.statusCode).toBe(200);
    const docId = register.json().id;

    // List.
    const list = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/kyc/documents`,
      headers: bearer('owner'),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().some((d: { id: string }) => d.id === docId)).toBe(true);

    // Download URL.
    const download = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/kyc/documents/${docId}/download`,
      headers: bearer('owner'),
    });
    expect(download.statusCode).toBe(200);
    expect(download.json().stub).toBe(true);
    expect(download.json().url).toMatch(/^stub:\/\//);
  });

  it('presign rejects an unsupported mime type with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/kyc/documents/presign`,
      headers: bearer('owner'),
      payload: { docType: 'pan', mimeType: 'application/exe', sizeBytes: 100 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('unsupported_mime');
  });

  it('register rejects a storage_key whose tenant prefix does not match', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/kyc/documents`,
      headers: bearer('owner'),
      payload: {
        docType: 'pan',
        storageKey: 'kyc/other-tenant/pan/abc',
        mimeType: 'application/pdf',
        sizeBytes: 1024,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('storage_key_invalid');
  });
});
