import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// email.ts imports ../logger.js, which calls pino() at module load using
// env.LOG_LEVEL/NODE_ENV; the partial env mocks below would make that throw.
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
vi.mock('../logger.js', () => ({ logger }));

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  logger.warn.mockClear();
});

async function load(envValue: Record<string, unknown>) {
  vi.doMock('../../config/env.js', () => ({ env: envValue }));
  return import('./email.js');
}

const okJson = (body: unknown) =>
  ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response;

const msg91Env = {
  NODE_ENV: 'production',
  MSG91_AUTH_KEY: 'msg91-key',
  MSG91_EMAIL_FROM: 'Circls <no-reply@event.circls.app>',
  MSG91_EMAIL_TEMPLATE_ID: '12345',
};

const invitation = {
  recipient: 'asha@example.com',
  templateKey: 'tenant.invitation',
  payload: {
    tenantName: 'Tigers Co',
    inviterName: 'Olivia',
    role: 'manager',
    inviteUrl: 'https://partners.circls.app/invite/abc',
    expiresAtIso: '2026-11-01',
  },
};

describe('MSG91 email', () => {
  it('sends through the generic template, ahead of Resend', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ status: 'success', hasError: false, data: { unique_id: 'uid-1' } }));
    const { getEmailProvider } = await load({
      ...msg91Env,
      RESEND_API_KEY: 're_test',
      RESEND_FROM: 'Circls <no-reply@circls.app>',
    });
    const provider = getEmailProvider();
    expect(provider.mode).toBe('msg91');

    const r = await provider.send(invitation);
    expect(r.providerMessageId).toBe('uid-1');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://control.msg91.com/api/v5/email/send');
    expect((init.headers as Record<string, string>)['authkey']).toBe('msg91-key');
    const body = JSON.parse(String(init.body)) as {
      recipients: Array<{ to: Array<{ email: string }>; variables: Record<string, string> }>;
      from: { email: string; name?: string };
      domain: string;
      template_id: string;
    };
    expect(body.template_id).toBe('12345');
    expect(body.domain).toBe('event.circls.app');
    expect(body.from).toEqual({ email: 'no-reply@event.circls.app', name: 'Circls' });
    expect(body.recipients[0]!.to).toEqual([{ email: 'asha@example.com' }]);
    expect(body.recipients[0]!.variables['VAR1']).toContain('Tigers Co');
    expect(body.recipients[0]!.variables['VAR2']).toContain('https://partners.circls.app/invite/abc');
    expect(body.recipients[0]!.variables['subject']).toBe(body.recipients[0]!.variables['VAR1']);
  });

  it('treats an HTTP error and a 200 with hasError as failures', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'bad key' } as unknown as Response);
    const { getEmailProvider } = await load(msg91Env);
    await expect(getEmailProvider().send(invitation)).rejects.toThrow(/msg91_email_send_failed:401/);

    fetchMock.mockResolvedValueOnce(okJson({ hasError: true, errors: { template_id: ['not found'] } }));
    await expect(getEmailProvider().send(invitation)).rejects.toThrow(/msg91_email_send_failed:200.*not found/);
  });

  it('honours MSG91_EMAIL_DOMAIN over the from address', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ data: { unique_id: 'uid-2' } }));
    const { getEmailProvider } = await load({ ...msg91Env, MSG91_EMAIL_DOMAIN: 'mail.circls.app' });
    await getEmailProvider().send(invitation);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((JSON.parse(String(init.body)) as { domain: string }).domain).toBe('mail.circls.app');
  });

  it('keeps Resend when only the auth key is set (SMS only)', async () => {
    const { getEmailProvider } = await load({
      NODE_ENV: 'production',
      MSG91_AUTH_KEY: 'msg91-key',
      RESEND_API_KEY: 're_test',
      RESEND_FROM: 'Circls <no-reply@circls.app>',
    });
    expect(getEmailProvider().mode).toBe('resend');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('fails the boot in production when MSG91 email is half-configured', async () => {
    const { getEmailProvider } = await load({
      NODE_ENV: 'production',
      MSG91_AUTH_KEY: 'msg91-key',
      MSG91_EMAIL_FROM: 'Circls <no-reply@event.circls.app>',
    });
    expect(() => getEmailProvider()).toThrow(/msg91_email_partial_config/);
  });

  it('parseFromAddress splits "Name <addr>" and passes a bare address through', async () => {
    const { parseFromAddress } = await load({});
    expect(parseFromAddress('Circls <no-reply@event.circls.app>')).toEqual({
      address: 'no-reply@event.circls.app',
      name: 'Circls',
    });
    expect(parseFromAddress('no-reply@event.circls.app')).toEqual({ address: 'no-reply@event.circls.app' });
  });
});
