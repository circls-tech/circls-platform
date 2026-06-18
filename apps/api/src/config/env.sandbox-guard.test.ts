import { describe, expect, it } from 'vitest';
import { envSchema } from './env.js';

const prodBase = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://x',
  RAZORPAY_KEY_ID: 'k',
  RAZORPAY_KEY_SECRET: 's',
  RAZORPAY_WEBHOOK_SECRET: 'w',
};

describe('production rejects sandbox-only env vars', () => {
  it('accepts a clean production env', () => {
    expect(envSchema.safeParse(prodBase).success).toBe(true);
  });
  it('rejects FIREBASE_AUTH_EMULATOR_HOST in production', () => {
    const r = envSchema.safeParse({ ...prodBase, FIREBASE_AUTH_EMULATOR_HOST: 'localhost:9099' });
    expect(r.success).toBe(false);
  });
  it('rejects SANDBOX_SMTP_HOST in production', () => {
    const r = envSchema.safeParse({ ...prodBase, SANDBOX_SMTP_HOST: 'mailpit' });
    expect(r.success).toBe(false);
  });
});
