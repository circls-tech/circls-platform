import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// MSG91 login codes on (vitest.setup clears the var; env.ts reads it on import).
// The daily ceiling sits above the per-IP cap so each limit can be hit alone.
process.env.MSG91_OTP_ENABLED = 'true';
process.env.LOGIN_OTP_DAILY_LIMIT = '25';

const DISABLED_PHONE = '+919000000009';

vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async () => {
    throw new Error('invalid token');
  }),
  firebaseUserForPhone: vi.fn(async (phone: string) => ({
    uid: `fb_${phone}`,
    disabled: phone === DISABLED_PHONE,
  })),
  createCustomToken: vi.fn(async (uid: string) => `token_for_${uid}`),
}));

// Capture each code instead of texting it.
const sent: { phoneE164: string; code: string; ttlMinutes: number }[] = [];
const send = vi.fn(async (input: { phoneE164: string; code: string; ttlMinutes: number }) => {
  sent.push(input);
  return { requestId: `req_${sent.length}` };
});
vi.mock('../lib/notifications/login_code.js', () => ({
  getLoginCodeSender: () => ({ mode: 'stub', send }),
}));

const { closeDb, db } = await import('../db/client.js');
const { phoneLoginCodes } = await import('../db/schema/index.js');
const { env } = await import('../config/env.js');
const { eq } = await import('drizzle-orm');
const { buildServer } = await import('../server.js');
const { purgeOldPhoneLoginCodes, startPhoneLogin, verifyPhoneLogin } = await import(
  '../services/phone_login_service.js'
);
const { firebaseUserForPhone } = await import('../lib/firebase_admin.js');

const runIntegration = Boolean(process.env.RUN_INTEGRATION);

const T0 = new Date('2026-10-27T10:00:00Z');
const at = (sec: number) => new Date(T0.getTime() + sec * 1000);
const lastCode = () => sent[sent.length - 1]!.code;
/** A code that isn't `code`. */
const wrong = (code: string) => (code === '000000' ? '111111' : '000000');

async function errorOf(p: Promise<unknown>): Promise<{ code: string; httpStatus: number; details?: unknown }> {
  try {
    await p;
  } catch (err) {
    return err as { code: string; httpStatus: number; details?: unknown };
  }
  throw new Error('expected a rejection');
}

describe.skipIf(!runIntegration)('consumer phone login (Circls codes)', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await closeDb();
  });
  beforeEach(async () => {
    await db.delete(phoneLoginCodes);
    sent.length = 0;
    send.mockClear();
    env.MSG91_OTP_ENABLED = true;
  });

  const start = (phone: string) =>
    app.inject({ method: 'POST', url: '/v1/auth/phone/start', payload: { phone } });
  const verify = (phone: string, code: string) =>
    app.inject({ method: 'POST', url: '/v1/auth/phone/verify', payload: { phone, code } });

  it('leaves other countries on Firebase without sending anything', async () => {
    const res = await start('+15555550102');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ provider: 'firebase' });
    expect(send).not.toHaveBeenCalled();
  });

  it('leaves Indian numbers on Firebase while the switch is off', async () => {
    env.MSG91_OTP_ENABLED = false;
    const res = await start('+919876543210');
    expect(res.json()).toEqual({ provider: 'firebase' });
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses a +91 number that is not an Indian mobile, and a malformed one', async () => {
    const notMobile = await start('+911234567890');
    expect(notMobile.statusCode).toBe(400);
    expect(notMobile.json().error.code).toBe('invalid_phone');
    const malformed = await start('+91 98765 abc');
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error.code).toBe('bad_request');
    expect(send).not.toHaveBeenCalled();
  });

  it('texts a code and signs in with it exactly once', async () => {
    const phone = '+919876543210';
    const res = await start(phone);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ provider: 'circls', expiresInSec: 600, resendAfterSec: 30 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(sent[0]).toMatchObject({ phoneE164: phone, ttlMinutes: 10 });
    expect(lastCode()).toMatch(/^\d{6}$/);

    const [row] = await db.select().from(phoneLoginCodes).where(eq(phoneLoginCodes.phoneE164, phone));
    expect(row!.providerRequestId).toBe('req_1');
    expect(row!.codeHash).not.toContain(lastCode());

    const bad = await verify(phone, wrong(lastCode()));
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatchObject({ code: 'invalid_code', details: { attemptsLeft: 4 } });

    const ok = await verify(phone, ` ${lastCode()} `);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ customToken: `token_for_fb_${phone}` });
    expect(firebaseUserForPhone).toHaveBeenCalledWith(phone);

    const again = await verify(phone, lastCode());
    expect(again.statusCode).toBe(400);
    expect(again.json().error.code).toBe('code_expired');
  });

  it('makes a resend wait out the cooldown', async () => {
    const phone = '+919876543211';
    expect((await start(phone)).statusCode).toBe(200);
    const res = await start(phone);
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('rate_limited');
    expect(res.json().error.details.retryAfterSec).toBeGreaterThan(0);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('only accepts the newest code once a new one is sent', async () => {
    const phone = '+919876543212';
    await startPhoneLogin(phone, null, at(0));
    const first = lastCode();
    await startPhoneLogin(phone, null, at(31));
    const second = lastCode();
    if (first !== second) {
      expect((await errorOf(verifyPhoneLogin(phone, first, at(40)))).code).toBe('invalid_code');
    }
    await expect(verifyPhoneLogin(phone, second, at(41))).resolves.toEqual({
      customToken: `token_for_fb_${phone}`,
    });
  });

  it('expires a code after ten minutes', async () => {
    const phone = '+919876543213';
    await startPhoneLogin(phone, null, at(0));
    const err = await errorOf(verifyPhoneLogin(phone, lastCode(), at(10 * 60)));
    expect(err.code).toBe('code_expired');
  });

  it('caps wrong guesses per code, after which even the right one is refused', async () => {
    const phone = '+919876543214';
    await startPhoneLogin(phone, null, at(0));
    const code = lastCode();
    for (const left of [4, 3, 2, 1]) {
      const err = await errorOf(verifyPhoneLogin(phone, wrong(code), at(5)));
      expect(err).toMatchObject({ code: 'invalid_code', details: { attemptsLeft: left } });
    }
    expect((await errorOf(verifyPhoneLogin(phone, wrong(code), at(6)))).code).toBe('too_many_attempts');
    const err = await errorOf(verifyPhoneLogin(phone, code, at(7)));
    expect(err).toMatchObject({ code: 'too_many_attempts', httpStatus: 429 });
  });

  it('caps codes per number per hour', async () => {
    const phone = '+919876543215';
    for (let i = 0; i < 5; i++) {
      await expect(startPhoneLogin(phone, null, at(i * 31))).resolves.toMatchObject({ provider: 'circls' });
    }
    const err = await errorOf(startPhoneLogin(phone, null, at(5 * 31)));
    expect(err).toMatchObject({ code: 'rate_limited', httpStatus: 429 });
    await expect(startPhoneLogin(phone, null, at(3600 + 1))).resolves.toMatchObject({ provider: 'circls' });
  });

  it('hands an IP past its hourly cap to Firebase (carriers share addresses)', async () => {
    for (let i = 0; i < 20; i++) {
      await startPhoneLogin(`+9198765${String(i).padStart(5, '0')}`, '203.0.113.7', at(i));
    }
    await expect(startPhoneLogin('+919876599999', '203.0.113.7', at(21))).resolves.toEqual({
      provider: 'firebase',
    });
    expect(send).toHaveBeenCalledTimes(20);
    await expect(startPhoneLogin('+919876599999', '203.0.113.8', at(22))).resolves.toMatchObject({
      provider: 'circls',
    });
  });

  it('hands sign-ins to Firebase past the daily limit', async () => {
    for (let i = 0; i < 25; i++) {
      await startPhoneLogin(`+9188765${String(i).padStart(5, '0')}`, null, at(i));
    }
    await expect(startPhoneLogin('+918876599999', null, at(30))).resolves.toEqual({ provider: 'firebase' });
    expect(send).toHaveBeenCalledTimes(25);
    // A day later the window has cleared.
    await expect(startPhoneLogin('+918876599999', null, at(24 * 3600 + 30))).resolves.toMatchObject({
      provider: 'circls',
    });
  });

  it('hands the sign-in to Firebase when MSG91 fails, leaving no live code', async () => {
    const phone = '+919876543216';
    send.mockRejectedValueOnce(new Error('msg91_otp_send_failed:500:'));
    await expect(startPhoneLogin(phone, null, at(0))).resolves.toEqual({ provider: 'firebase' });
    const rows = await db.select().from(phoneLoginCodes).where(eq(phoneLoginCodes.phoneE164, phone));
    expect(rows).toHaveLength(0);
    // Nothing went out, so no cooldown either.
    await expect(startPhoneLogin(phone, null, at(1))).resolves.toMatchObject({ provider: 'circls' });
  });

  it('refuses a disabled account', async () => {
    await startPhoneLogin(DISABLED_PHONE, null, at(0));
    const err = await errorOf(verifyPhoneLogin(DISABLED_PHONE, lastCode(), at(5)));
    expect(err).toMatchObject({ code: 'account_disabled', httpStatus: 403 });
  });

  it('purges codes older than 30 days', async () => {
    await startPhoneLogin('+919876543217', null, at(0));
    await startPhoneLogin('+919876543218', null, at(20 * 24 * 3600));
    const purged = await purgeOldPhoneLoginCodes(at(31 * 24 * 3600));
    expect(purged).toBe(1);
    const left = await db.select({ phone: phoneLoginCodes.phoneE164 }).from(phoneLoginCodes);
    expect(left.map((r) => r.phone)).toEqual(['+919876543218']);
  });
});
