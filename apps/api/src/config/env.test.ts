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
