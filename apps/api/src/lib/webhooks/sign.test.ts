import { describe, expect, it, vi } from 'vitest';
import { signWebhook, verifyWebhook } from './sign.js';

describe('signWebhook / verifyWebhook', () => {
  const secret = 'test_secret_kAJqK9pV';
  const body = JSON.stringify({ event_type: 'booking.confirmed', booking_id: 'b1' });

  it('round-trips with the matching secret', () => {
    const { signatureHeader } = signWebhook(body, secret);
    expect(verifyWebhook(body, signatureHeader, secret)).toBe(true);
  });

  it('fails verification when secret differs', () => {
    const { signatureHeader } = signWebhook(body, secret);
    expect(verifyWebhook(body, signatureHeader, 'wrong_secret')).toBe(false);
  });

  it('fails verification when body has been tampered with', () => {
    const { signatureHeader } = signWebhook(body, secret);
    expect(verifyWebhook(body + 'tamper', signatureHeader, secret)).toBe(false);
  });

  it('rejects a signature outside the replay-tolerance window', () => {
    // Sign with frozen clock at t0, advance well past 5min, verify → reject.
    const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(t0);
      const { signatureHeader } = signWebhook(body, secret);
      // 6 minutes later — outside the default 5-min tolerance.
      vi.setSystemTime(t0 + 6 * 60_000);
      expect(verifyWebhook(body, signatureHeader, secret)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('accepts a signature inside the tolerance window', () => {
    const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(t0);
      const { signatureHeader } = signWebhook(body, secret);
      // 1 minute later — comfortably within tolerance.
      vi.setSystemTime(t0 + 60_000);
      expect(verifyWebhook(body, signatureHeader, secret)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects malformed signature headers', () => {
    expect(verifyWebhook(body, 'garbage', secret)).toBe(false);
    expect(verifyWebhook(body, 't=abc,v1=ff', secret)).toBe(false);
    expect(verifyWebhook(body, `t=${Date.now()}`, secret)).toBe(false);
  });

  it('produces a header in t=...,v1=... shape', () => {
    const { signatureHeader, timestamp } = signWebhook(body, secret);
    expect(signatureHeader).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(signatureHeader).toContain(`t=${timestamp}`);
  });
});
