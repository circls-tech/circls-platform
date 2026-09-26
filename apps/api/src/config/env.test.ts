import { describe, expect, it } from 'vitest';
import { envSchema } from './env.js';

describe('envSchema production refinement', () => {
  it('fails in production when razorpay keys are missing', () => {
    const result = envSchema.safeParse({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://x',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('RAZORPAY_KEY_ID');
      expect(paths).toContain('RAZORPAY_KEY_SECRET');
      expect(paths).toContain('RAZORPAY_WEBHOOK_SECRET');
    }
  });

  it('succeeds in production when all razorpay keys are present', () => {
    const result = envSchema.safeParse({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://x',
      RAZORPAY_KEY_ID: 'key',
      RAZORPAY_KEY_SECRET: 'secret',
      RAZORPAY_WEBHOOK_SECRET: 'whsecret',
    });
    expect(result.success).toBe(true);
  });

  it('requires live Cashfree keys + production host when INR routes to cashfree in production', () => {
    const base = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://x',
      RAZORPAY_KEY_ID: 'key',
      RAZORPAY_KEY_SECRET: 'secret',
      RAZORPAY_WEBHOOK_SECRET: 'whsecret',
      INR_PAYMENT_GATEWAY: 'cashfree',
    };
    const missing = envSchema.safeParse(base);
    expect(missing.success).toBe(false);
    if (!missing.success) {
      const paths = missing.error.issues.map((i) => i.path.join('.'));
      expect(paths).toEqual(
        expect.arrayContaining(['CASHFREE_CLIENT_ID', 'CASHFREE_CLIENT_SECRET', 'CASHFREE_ENV']),
      );
    }
    const ok = envSchema.safeParse({
      ...base,
      CASHFREE_CLIENT_ID: 'id',
      CASHFREE_CLIENT_SECRET: 'secret',
      CASHFREE_ENV: 'production',
    });
    expect(ok.success).toBe(true);
  });

  it('defaults INR to razorpay and does not require Cashfree keys', () => {
    const result = envSchema.safeParse({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://x',
      RAZORPAY_KEY_ID: 'key',
      RAZORPAY_KEY_SECRET: 'secret',
      RAZORPAY_WEBHOOK_SECRET: 'whsecret',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.INR_PAYMENT_GATEWAY).toBe('razorpay');
  });

  it('allows the stub (missing razorpay keys) in development', () => {
    const result = envSchema.safeParse({
      NODE_ENV: 'development',
      DATABASE_URL: 'postgres://x',
    });
    expect(result.success).toBe(true);
  });

  it('allows both apex and www consumer origins by default', () => {
    const result = envSchema.safeParse({
      NODE_ENV: 'development',
      DATABASE_URL: 'postgres://x',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.CORS_ALLOWED_ORIGINS).toContain('https://circls.app');
      expect(result.data.CORS_ALLOWED_ORIGINS).toContain('https://www.circls.app');
    }
  });
});
