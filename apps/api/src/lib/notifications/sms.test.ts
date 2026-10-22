import { afterEach, describe, expect, it, vi } from 'vitest';

// sms.ts imports ../logger.js, which calls pino() at module load using
// env.LOG_LEVEL/NODE_ENV; the partial env mocks below would make that throw.
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
vi.mock('../logger.js', () => ({ logger }));

afterEach(() => {
  vi.resetModules();
  logger.warn.mockClear();
});

async function load(envValue: Record<string, unknown>) {
  vi.doMock('../../config/env.js', () => ({ env: envValue }));
  return import('./sms.js');
}

describe('getSmsProvider', () => {
  it('stays in stub mode with only the auth key (shared with MSG91 Email)', async () => {
    const { getSmsProvider } = await load({ MSG91_AUTH_KEY: 'msg91-key', MSG91_SMS_ENABLED: false });
    expect(getSmsProvider().mode).toBe('stub');
  });

  it('sends through MSG91 once switched on', async () => {
    const { getSmsProvider } = await load({ MSG91_AUTH_KEY: 'msg91-key', MSG91_SMS_ENABLED: true });
    expect(getSmsProvider().mode).toBe('msg91');
  });

  it('warns and stays in stub mode when switched on without a key', async () => {
    const { getSmsProvider } = await load({ MSG91_SMS_ENABLED: true });
    expect(getSmsProvider().mode).toBe('stub');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/msg91_sms_enabled_without_key/));
  });
});
