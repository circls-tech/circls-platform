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
      // Preview links must verify on every instance, so the signing secret
      // is required in production too.
      expect(paths).toContain('LISTING_PREVIEW_SECRET');
    }
  });

  it('succeeds in production when all razorpay keys are present', () => {
    const result = envSchema.safeParse({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://x',
      RAZORPAY_KEY_ID: 'key',
      RAZORPAY_KEY_SECRET: 'secret',
      RAZORPAY_WEBHOOK_SECRET: 'whsecret',
      LISTING_PREVIEW_SECRET: 'a-preview-secret-for-tests',
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
      LISTING_PREVIEW_SECRET: 'a-preview-secret-for-tests',
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

  it('refuses live Cashfree keys pointed at the sandbox, even while INR is on Razorpay', () => {
    const base = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://x',
      RAZORPAY_KEY_ID: 'key',
      RAZORPAY_KEY_SECRET: 'secret',
      RAZORPAY_WEBHOOK_SECRET: 'whsecret',
      LISTING_PREVIEW_SECRET: 'a-preview-secret-for-tests',
      CASHFREE_CLIENT_ID: 'id',
      CASHFREE_CLIENT_SECRET: 'secret',
    };
    const sandbox = envSchema.safeParse(base);
    expect(sandbox.success).toBe(false);
    if (!sandbox.success) {
      expect(sandbox.error.issues.map((i) => i.path.join('.'))).toEqual(['CASHFREE_ENV']);
    }
    expect(envSchema.safeParse({ ...base, CASHFREE_ENV: 'production' }).success).toBe(true);
  });

  it('defaults the gateway timeout and failover tuning', () => {
    const result = envSchema.safeParse({ NODE_ENV: 'development', DATABASE_URL: 'postgres://x' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.GATEWAY_HTTP_TIMEOUT_MS).toBe(10_000);
      expect(result.data.INR_FAILOVER_THRESHOLD).toBe(3);
      expect(result.data.INR_FAILOVER_WINDOW_SEC).toBe(300);
      expect(result.data.INR_FAILOVER_COOLDOWN_SEC).toBe(600);
    }
  });

  it('without Cashfree keys, INR defaults to Razorpay and needs nothing more', () => {
    const result = envSchema.safeParse({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://x',
      RAZORPAY_KEY_ID: 'key',
      RAZORPAY_KEY_SECRET: 'secret',
      RAZORPAY_WEBHOOK_SECRET: 'whsecret',
      LISTING_PREVIEW_SECRET: 'a-preview-secret-for-tests',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.INR_PAYMENT_GATEWAY).toBe('razorpay');
  });

  it('INR defaults to Cashfree once both Cashfree keys are set', () => {
    const prod = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://x',
      RAZORPAY_KEY_ID: 'key',
      RAZORPAY_KEY_SECRET: 'secret',
      RAZORPAY_WEBHOOK_SECRET: 'whsecret',
      LISTING_PREVIEW_SECRET: 'a-preview-secret-for-tests',
      CASHFREE_CLIENT_ID: 'id',
      CASHFREE_CLIENT_SECRET: 'secret',
      CASHFREE_ENV: 'production',
    };
    const byDefault = envSchema.safeParse(prod);
    expect(byDefault.success && byDefault.data.INR_PAYMENT_GATEWAY).toBe('cashfree');
    // Blank is unset (compose passes an empty value through).
    const blank = envSchema.safeParse({ ...prod, INR_PAYMENT_GATEWAY: '' });
    expect(blank.success && blank.data.INR_PAYMENT_GATEWAY).toBe('cashfree');
    // One key alone isn't a Cashfree setup.
    const oneKey = envSchema.safeParse({
      NODE_ENV: 'development',
      DATABASE_URL: 'postgres://x',
      CASHFREE_CLIENT_ID: 'id',
    });
    expect(oneKey.success && oneKey.data.INR_PAYMENT_GATEWAY).toBe('razorpay');
  });

  it('an explicit INR_PAYMENT_GATEWAY wins over the keys', () => {
    const result = envSchema.safeParse({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://x',
      RAZORPAY_KEY_ID: 'key',
      RAZORPAY_KEY_SECRET: 'secret',
      RAZORPAY_WEBHOOK_SECRET: 'whsecret',
      LISTING_PREVIEW_SECRET: 'a-preview-secret-for-tests',
      CASHFREE_CLIENT_ID: 'id',
      CASHFREE_CLIENT_SECRET: 'secret',
      CASHFREE_ENV: 'production',
      INR_PAYMENT_GATEWAY: 'razorpay',
    });
    expect(result.success && result.data.INR_PAYMENT_GATEWAY).toBe('razorpay');
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
