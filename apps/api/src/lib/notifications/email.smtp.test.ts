import { afterEach, describe, expect, it, vi } from 'vitest';

const sendMail = vi.fn(async () => ({ messageId: '<sandbox-1@mailpit>' }));
vi.mock('nodemailer', () => ({
  default: { createTransport: () => ({ sendMail }) },
}));
// email.ts imports ../logger.js, which calls pino() at module load using
// env.LOG_LEVEL/NODE_ENV. The empty-env mocks below would make pino throw on an
// undefined level before getEmailProvider() ever runs, so stub the logger out.
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

afterEach(() => {
  vi.resetModules();
  sendMail.mockClear();
});

describe('getEmailProvider SMTP selection', () => {
  it('uses the SMTP provider when SANDBOX_SMTP_HOST is set', async () => {
    vi.doMock('../../config/env.js', () => ({
      env: { SANDBOX_SMTP_HOST: 'mailpit', SANDBOX_SMTP_PORT: 1025, RESEND_FROM: 'Sandbox <no-reply@local>' },
    }));
    const { getEmailProvider } = await import('./email.js');
    const provider = getEmailProvider();
    expect(provider.mode).toBe('smtp');
    await provider.send({ recipient: 'a@b.com', templateKey: 'tenant.invitation', payload: {} as never });
    expect(sendMail).toHaveBeenCalledOnce();
  });

  it('falls back to stub when nothing is configured', async () => {
    vi.doMock('../../config/env.js', () => ({ env: {} }));
    const { getEmailProvider } = await import('./email.js');
    expect(getEmailProvider().mode).toBe('stub');
  });
});
