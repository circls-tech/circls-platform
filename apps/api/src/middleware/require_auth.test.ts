import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';

// Hand-rolled mock of firebase_admin.verifyIdToken so we can exercise the
// middleware without a real Firebase project. Each test seeds the next decoded
// token via `nextToken`. Importing the middleware after vi.mock() ensures the
// mocked module is wired in.
let nextToken: Record<string, unknown> = {};
vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async () => nextToken),
}));

const { requireAuth } = await import('./require_auth.js');

function fakeReq(): FastifyRequest {
  return {
    headers: { authorization: 'Bearer good' },
    log: { warn() {} },
  } as unknown as FastifyRequest;
}

describe('requireAuth — email_verified gating (C1)', () => {
  afterEach(() => {
    nextToken = {};
  });

  it('trusts the email claim when email_verified is true', async () => {
    nextToken = { uid: 'u1', email: 'x@y.com', email_verified: true };
    const req = fakeReq();
    await requireAuth(req, {} as never);
    expect(req.authUser?.email).toBe('x@y.com');
  });

  it('drops the email claim when email_verified is false (vuln-closing)', async () => {
    nextToken = { uid: 'u1', email: 'x@y.com', email_verified: false };
    const req = fakeReq();
    await requireAuth(req, {} as never);
    expect(req.authUser?.email).toBeNull();
  });

  it('drops the email claim when email_verified is absent/undefined', async () => {
    nextToken = { uid: 'u1', email: 'x@y.com' };
    const req = fakeReq();
    await requireAuth(req, {} as never);
    expect(req.authUser?.email).toBeNull();
  });

  it('leaves the phone claim untouched (phone is inherently verified)', async () => {
    nextToken = { uid: 'u1', phone_number: '+15551234567' };
    const req = fakeReq();
    await requireAuth(req, {} as never);
    expect(req.authUser?.phoneE164).toBe('+15551234567');
    expect(req.authUser?.email).toBeNull();
  });
});
