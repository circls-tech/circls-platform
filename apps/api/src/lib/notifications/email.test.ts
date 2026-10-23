import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminListingSubmitted } from './email_designs/admin.js';
import { bookingConfirmed } from './email_designs/consumer.js';

const sendMail = vi.fn(async () => ({ messageId: '<sandbox-1@mailpit>' }));
vi.mock('nodemailer', () => ({
  default: { createTransport: () => ({ sendMail }) },
}));
// email.ts imports ../logger.js, which calls pino() at module load using
// env.LOG_LEVEL/NODE_ENV. The empty-env mocks below would make pino throw on an
// undefined level before getEmailProvider() ever runs, so stub the logger out.
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
vi.mock('../logger.js', () => ({ logger }));

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  sendMail.mockClear();
  fetchMock.mockReset();
  logger.warn.mockClear();
});

const okJson = (body: unknown) =>
  ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as unknown as Response;

const msg91Ok = { status: 'success', hasError: false, message: 'queued', data: { unique_id: 'uid-1' } };

const bothConfigured = {
  NODE_ENV: 'development',
  MSG91_AUTH_KEY: 'msg91-key',
  MSG91_EMAIL_FROM: 'Circls <no-reply@circls.app>',
  MSG91_EMAIL_TEMPLATE_ID: 'circls_transactional',
  RESEND_API_KEY: 're_test',
  RESEND_FROM: 'Circls Ops <ops@circls.app>',
};

// What every mocked env needs besides the senders: the portal base URLs the
// designs link to, and the (empty) MSG91 design switches.
const baseEnv = {
  CONSUMER_BASE_URL: 'https://circls.app',
  PARTNERS_BASE_URL: 'https://partners.circls.app',
  ADMIN_BASE_URL: 'https://admin.circls.app',
  MSG91_EMAIL_TEMPLATES: {},
  MSG91_EMAIL_DESIGNS: [],
};

async function load(envValue: Record<string, unknown>) {
  vi.doMock('../../config/env.js', () => ({ env: { ...baseEnv, ...envValue } }));
  return import('./email.js');
}

// A customer email with no design: always the generic MSG91 template.
const consumerSend = {
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
// A designed customer email.
const designedSend = {
  recipient: 'asha@example.com',
  templateKey: 'booking.confirmed',
  payload: bookingConfirmed.sample,
};
const adminSend = {
  recipient: 'ops@circls.app',
  templateKey: 'admin.listing_submitted',
  payload: adminListingSubmitted.sample,
};

interface Msg91Body {
  recipients: Array<{ to: Array<{ email: string }>; variables: { subject: string; body: string; VAR1: string; VAR2: string } }>;
  from: { email: string; name?: string };
  domain: string;
  template_id: string;
}

describe('getEmailProvider — sandbox + stub', () => {
  it('uses the SMTP sink for BOTH audiences when SANDBOX_SMTP_HOST is set', async () => {
    const { getEmailProvider } = await load({
      SANDBOX_SMTP_HOST: 'mailpit',
      SANDBOX_SMTP_PORT: 1025,
      MSG91_EMAIL_FROM: 'Sandbox <no-reply@local>',
    });
    const provider = getEmailProvider();
    expect(provider.mode).toBe('smtp');
    expect(provider.external.mode).toBe('smtp');
    expect(provider.internal.mode).toBe('smtp');
    await provider.send(consumerSend);
    await provider.send(adminSend);
    expect(sendMail).toHaveBeenCalledTimes(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to stub for both when nothing is configured', async () => {
    const { getEmailProvider } = await load({});
    const provider = getEmailProvider();
    expect(provider.external.mode).toBe('stub');
    expect(provider.internal.mode).toBe('stub');
    const r = await provider.send(adminSend);
    expect(r.providerMessageId).toMatch(/^stub_email_/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats MSG91_AUTH_KEY alone as SMS-only, not a half-configured email sender', async () => {
    const { getEmailProvider } = await load({ NODE_ENV: 'production', MSG91_AUTH_KEY: 'msg91-key' });
    const provider = getEmailProvider();
    expect(provider.external.mode).toBe('stub');
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('getEmailProvider — routing by audience', () => {
  it('sends customer mail through MSG91 and admin mail through Resend', async () => {
    fetchMock.mockResolvedValueOnce(okJson(msg91Ok)).mockResolvedValueOnce(okJson({ id: 'resend-msg-1' }));
    const { getEmailProvider } = await load(bothConfigured);
    const provider = getEmailProvider();
    expect(provider.mode).toBe('msg91');
    expect(provider.external.mode).toBe('msg91');
    expect(provider.internal.mode).toBe('resend');

    const consumer = await provider.send(consumerSend);
    expect(consumer.providerMessageId).toBe('uid-1');
    const [msg91Url, msg91Init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(msg91Url).toBe('https://control.msg91.com/api/v5/email/send');
    expect((msg91Init.headers as Record<string, string>)['authkey']).toBe('msg91-key');
    const msg91Body = JSON.parse(String(msg91Init.body)) as Msg91Body;
    expect(msg91Body.from).toEqual({ email: 'no-reply@circls.app', name: 'Circls' });
    expect(msg91Body.domain).toBe('circls.app'); // derived from the from address
    expect(msg91Body.template_id).toBe('circls_transactional');
    expect(msg91Body.recipients).toHaveLength(1);
    expect(msg91Body.recipients[0]!.to).toEqual([{ email: 'asha@example.com' }]);
    expect(msg91Body.recipients[0]!.variables.subject).toBe("You've been invited to join Tigers Co");
    expect(msg91Body.recipients[0]!.variables.body).toContain('https://partners.circls.app/invite/abc');
    // MSG91's default variable names work too.
    expect(msg91Body.recipients[0]!.variables.VAR1).toBe("You've been invited to join Tigers Co");
    expect(msg91Body.recipients[0]!.variables.VAR2).toContain('https://partners.circls.app/invite/abc');

    const admin = await provider.send(adminSend);
    expect(admin.providerMessageId).toBe('resend-msg-1');
    const [resendUrl, resendInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(resendUrl).toBe('https://api.resend.com/emails');
    expect((resendInit.headers as Record<string, string>)['Authorization']).toBe('Bearer re_test');
    const resendBody = JSON.parse(String(resendInit.body)) as { from: string; to: string[]; subject: string; html?: string; text: string };
    expect(resendBody.from).toBe('Circls Ops <ops@circls.app>');
    expect(resendBody.to).toEqual(['ops@circls.app']);
    expect(resendBody.subject).toBe('[Review] Event · Sunday 10K Social — Sunrise Run Club');
    // Resend gets the designed HTML plus the text alternative.
    expect(resendBody.html).toContain('Review now');
    expect(resendBody.text).toContain('Sunday 10K Social');
  });

  it('uses MSG91_EMAIL_DOMAIN over the from address domain when set', async () => {
    fetchMock.mockResolvedValueOnce(okJson(msg91Ok));
    const { getEmailProvider } = await load({ ...bothConfigured, MSG91_EMAIL_DOMAIN: 'mail.circls.app' });
    await getEmailProvider().send(consumerSend);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((JSON.parse(String(init.body)) as Msg91Body).domain).toBe('mail.circls.app');
  });

  it('surfaces an MSG91 HTTP rejection as msg91_email_send_failed', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => '{"hasError":true,"message":"Invalid authkey"}',
      json: async () => ({}),
    } as unknown as Response);
    const { getEmailProvider } = await load(bothConfigured);
    await expect(getEmailProvider().send(consumerSend)).rejects.toThrow(/msg91_email_send_failed:401/);
  });

  it('treats a 200 with hasError:true as a failure too', async () => {
    fetchMock.mockResolvedValueOnce(
      okJson({ status: 'fail', hasError: true, errors: { template_id: ['not found'] }, message: 'error' }),
    );
    const { getEmailProvider } = await load(bothConfigured);
    await expect(getEmailProvider().send(consumerSend)).rejects.toThrow(/msg91_email_send_failed:200.*not found/);
  });

  it('routes customer mail through Resend (with a warning) while MSG91 email is unset', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ id: 'resend-msg-2' }));
    const { getEmailProvider } = await load({
      NODE_ENV: 'production',
      RESEND_API_KEY: 're_test',
      RESEND_FROM: 'Circls <no-reply@circls.app>',
    });
    const provider = getEmailProvider();
    expect(provider.external.mode).toBe('resend');
    expect(provider.internal.mode).toBe('resend');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/msg91_email_not_configured/));
    await provider.send(consumerSend);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.resend.com/emails');
  });

  it('routes admin mail through MSG91 (with a warning) while Resend is unset', async () => {
    fetchMock.mockResolvedValueOnce(okJson(msg91Ok));
    const { getEmailProvider } = await load({
      NODE_ENV: 'production',
      MSG91_AUTH_KEY: 'msg91-key',
      MSG91_EMAIL_FROM: 'no-reply@circls.app',
      MSG91_EMAIL_TEMPLATE_ID: 'circls_transactional',
    });
    const provider = getEmailProvider();
    expect(provider.external.mode).toBe('msg91');
    expect(provider.internal.mode).toBe('msg91');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/resend_not_configured/));
    await provider.send(adminSend);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://control.msg91.com/api/v5/email/send');
    // A bare from address → no name field.
    expect((JSON.parse(String(init.body)) as Msg91Body).from).toEqual({ email: 'no-reply@circls.app' });
  });

  it('fails the boot in production when the MSG91 email sender is half-configured', async () => {
    const { getEmailProvider } = await load({
      NODE_ENV: 'production',
      MSG91_AUTH_KEY: 'msg91-key',
      MSG91_EMAIL_FROM: 'Circls <no-reply@circls.app>',
      // MSG91_EMAIL_TEMPLATE_ID missing
      RESEND_API_KEY: 're_test',
      RESEND_FROM: 'Circls <no-reply@circls.app>',
    });
    expect(() => getEmailProvider()).toThrow(/msg91_email_partial_config/);
  });

  it('fails the boot in production when Resend is half-configured', async () => {
    const { getEmailProvider } = await load({ NODE_ENV: 'production', RESEND_API_KEY: 're_test' });
    expect(() => getEmailProvider()).toThrow(/resend_partial_config/);
  });

  it('warns but stubs in development when a sender is half-configured', async () => {
    const { getEmailProvider } = await load({ NODE_ENV: 'development', MSG91_EMAIL_TEMPLATE_ID: 'tpl' });
    const provider = getEmailProvider();
    expect(provider.external.mode).toBe('stub');
    expect(provider.internal.mode).toBe('stub');
    expect(logger.warn).toHaveBeenCalledWith(
      { missing: ['MSG91_AUTH_KEY', 'MSG91_EMAIL_FROM'] },
      expect.stringMatching(/msg91_email_partial_config/),
    );
  });
});

describe('designed emails through MSG91', () => {
  it('go through the generic template, as their text version, until switched on', async () => {
    fetchMock.mockResolvedValueOnce(okJson(msg91Ok));
    const { getEmailProvider } = await load(bothConfigured);
    await getEmailProvider().send(designedSend);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Msg91Body;
    expect(body.template_id).toBe('circls_transactional');
    expect(body.recipients[0]!.variables.VAR1).toBe('You’re booked in — Bandra Sports Club, Sat 4 Oct');
    expect(body.recipients[0]!.variables.VAR2).toContain('Arena: Turf 2 · 5-a-side');
  });

  it('use their own template with the full variables once switched on', async () => {
    fetchMock.mockResolvedValueOnce(okJson(msg91Ok));
    const { getEmailProvider } = await load({ ...bothConfigured, MSG91_EMAIL_DESIGNS: ['booking.confirmed'] });
    await getEmailProvider().send(designedSend);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { template_id: string; recipients: Array<{ variables: Record<string, unknown> }> };
    expect(body.template_id).toBe('circls_booking_confirmed');
    const vars = body.recipients[0]!.variables;
    expect(vars['placeName']).toBe('Bandra Sports Club');
    expect(vars['rows']).toEqual(bookingConfirmed.sample['rows']);
    // The shared values the designs link with are filled in at send time.
    expect(vars['consumerUrl']).toBe('https://circls.app');
    expect(vars['partnersUrl']).toBe('https://partners.circls.app');
  });

  it('sends Reply-To when EMAIL_REPLY_TO is set', async () => {
    fetchMock.mockResolvedValueOnce(okJson(msg91Ok));
    const { getEmailProvider } = await load({ ...bothConfigured, EMAIL_REPLY_TO: 'support@circls.app' });
    await getEmailProvider().send(consumerSend);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((JSON.parse(String(init.body)) as { reply_to?: unknown }).reply_to).toEqual([{ email: 'support@circls.app' }]);
  });
});

describe('parseFromAddress', () => {
  it('splits "Name <addr>" and passes a bare address through', async () => {
    const { parseFromAddress } = await load({});
    expect(parseFromAddress('Circls <no-reply@circls.app>')).toEqual({
      address: 'no-reply@circls.app',
      name: 'Circls',
    });
    expect(parseFromAddress('"Circls Ops" <ops@circls.app>')).toEqual({
      address: 'ops@circls.app',
      name: 'Circls Ops',
    });
    expect(parseFromAddress('no-reply@circls.app')).toEqual({ address: 'no-reply@circls.app' });
  });
});
