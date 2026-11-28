import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  ACCESS_CODE_HEADER,
  ACCESS_CODE_MAX_FAILURES,
  AccessCodeAttempts,
  accessCodeHeaderOf,
  withAccessCodeAttempt,
} from './access_code_attempts.js';
import { Forbidden } from './errors.js';

function req(ip: string, headers: Record<string, string> = {}): FastifyRequest {
  return { ip, headers } as unknown as FastifyRequest;
}

describe('AccessCodeAttempts', () => {
  it('blocks a key after the ceiling and frees it when the window ends', () => {
    let now = 1_000;
    const a = new AccessCodeAttempts(3, 60_000, () => now);
    a.recordFailure('k');
    a.recordFailure('k');
    expect(a.retryAfterSeconds('k')).toBe(0);
    a.recordFailure('k');
    expect(a.retryAfterSeconds('k')).toBe(60);
    expect(a.retryAfterSeconds('other')).toBe(0);
    now += 30_000;
    expect(a.retryAfterSeconds('k')).toBe(30);
    now += 30_000;
    expect(a.retryAfterSeconds('k')).toBe(0);
    // A fresh window starts counting from one again.
    a.recordFailure('k');
    expect(a.retryAfterSeconds('k')).toBe(0);
  });
});

describe('accessCodeHeaderOf', () => {
  it('decodes the header, and ignores a missing, malformed or oversized one', () => {
    expect(accessCodeHeaderOf(req('1.1.1.1'))).toBeUndefined();
    expect(accessCodeHeaderOf(req('1.1.1.1', { [ACCESS_CODE_HEADER]: '%20Club%20Night%20' }))).toBe(
      'Club Night',
    );
    expect(
      accessCodeHeaderOf(req('1.1.1.1', { [ACCESS_CODE_HEADER]: encodeURIComponent('क्लब-2026') })),
    ).toBe('क्लब-2026');
    expect(accessCodeHeaderOf(req('1.1.1.1', { [ACCESS_CODE_HEADER]: '%E0%A4%A' }))).toBeUndefined();
    expect(accessCodeHeaderOf(req('1.1.1.1', { [ACCESS_CODE_HEADER]: 'x'.repeat(65) }))).toBeUndefined();
  });
});

describe('withAccessCodeAttempt', () => {
  const wrong = async () => {
    throw new Forbidden('This event needs an access code', 'event_access_code_invalid');
  };

  it('counts wrong codes per caller per event, then refuses before checking', async () => {
    const caller = req('10.0.0.1');
    for (let i = 0; i < ACCESS_CODE_MAX_FAILURES; i += 1) {
      await expect(withAccessCodeAttempt(caller, 'ev-a', 'nope', wrong)).rejects.toMatchObject({
        code: 'event_access_code_invalid',
      });
    }
    let ran = false;
    await expect(
      withAccessCodeAttempt(caller, 'ev-a', 'right', async () => {
        ran = true;
      }),
    ).rejects.toMatchObject({ code: 'event_access_code_attempts', httpStatus: 429 });
    expect(ran).toBe(false);

    // Another event, and another caller, are untouched.
    await expect(withAccessCodeAttempt(caller, 'ev-b', 'right', async () => 'ok')).resolves.toBe('ok');
    await expect(
      withAccessCodeAttempt(req('10.0.0.2'), 'ev-a', 'right', async () => 'ok'),
    ).resolves.toBe('ok');
  });

  it('counts a locked read as a wrong code, and never counts a right one', async () => {
    const caller = req('10.0.0.3');
    for (let i = 0; i < ACCESS_CODE_MAX_FAILURES * 2; i += 1) {
      await withAccessCodeAttempt(caller, 'ev-c', 'right', async () => ({ locked: false }), (r) => r.locked);
    }
    for (let i = 0; i < ACCESS_CODE_MAX_FAILURES; i += 1) {
      await withAccessCodeAttempt(caller, 'ev-c', 'nope', async () => ({ locked: true }), (r) => r.locked);
    }
    await expect(
      withAccessCodeAttempt(caller, 'ev-c', 'nope', async () => ({ locked: true }), (r) => r.locked),
    ).rejects.toMatchObject({ code: 'event_access_code_attempts' });
  });

  it('does not count a request that carries no code', async () => {
    const caller = req('10.0.0.4');
    for (let i = 0; i < ACCESS_CODE_MAX_FAILURES + 2; i += 1) {
      await expect(withAccessCodeAttempt(caller, 'ev-d', undefined, wrong)).rejects.toMatchObject({
        code: 'event_access_code_invalid',
      });
    }
    await expect(withAccessCodeAttempt(caller, 'ev-d', 'right', async () => 'ok')).resolves.toBe('ok');
  });
});
