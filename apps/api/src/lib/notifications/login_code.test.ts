import { afterEach, describe, expect, it, vi } from 'vitest';

// login_code.ts imports ../logger.js, which calls pino() at module load using
// env.LOG_LEVEL/NODE_ENV; the partial env mocks below would make that throw.
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
vi.mock('../logger.js', () => ({ logger }));

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  logger.info.mockClear();
});

async function load(envValue: Record<string, unknown>) {
  vi.doMock('../../config/env.js', () => ({ env: envValue }));
  return import('./login_code.js');
}

const input = { phoneE164: '+919876543210', code: '042137', ttlMinutes: 10 };

describe('getLoginCodeSender', () => {
  it('only logs the code without the OTP template, even with the auth key', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { getLoginCodeSender } = await load({ MSG91_AUTH_KEY: 'msg91-key' });
    const sender = getLoginCodeSender();
    expect(sender.mode).toBe('stub');
    await expect(sender.send(input)).resolves.toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith({ to: input.phoneE164, code: '042137' }, 'login_code_stub');
  });

  it('sends our code through MSG91 SendOTP with the template', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ type: 'success', request_id: 'req_123' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { getLoginCodeSender } = await load({ MSG91_AUTH_KEY: 'msg91-key', MSG91_OTP_TEMPLATE_ID: 'tpl_1' });
    const sender = getLoginCodeSender();
    expect(sender.mode).toBe('msg91');
    await expect(sender.send(input)).resolves.toEqual({ requestId: 'req_123' });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://control.msg91.com/api/v5/otp');
    expect(Object.fromEntries(u.searchParams)).toEqual({
      template_id: 'tpl_1',
      mobile: '919876543210',
      otp: '042137',
      otp_length: '6',
      otp_expiry: '10',
    });
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authkey).toBe('msg91-key');
    // The code goes to MSG91, never into our logs.
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('throws when MSG91 answers type "error" with HTTP 200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ type: 'error', message: 'The provided flow ID or template ID is invalid.' }), {
            status: 200,
          }),
      ),
    );
    const { getLoginCodeSender } = await load({ MSG91_AUTH_KEY: 'msg91-key', MSG91_OTP_TEMPLATE_ID: 'tpl_1' });
    await expect(getLoginCodeSender().send(input)).rejects.toThrow(/msg91_otp_send_failed:200:The provided flow ID/);
  });

  it('throws on an HTTP error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ type: 'error', message: 'Auth Key missing' }), { status: 401 })),
    );
    const { getLoginCodeSender } = await load({ MSG91_AUTH_KEY: 'msg91-key', MSG91_OTP_TEMPLATE_ID: 'tpl_1' });
    await expect(getLoginCodeSender().send(input)).rejects.toThrow(/msg91_otp_send_failed:401/);
  });
});
