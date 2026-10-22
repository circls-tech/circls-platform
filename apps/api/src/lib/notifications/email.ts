import nodemailer from 'nodemailer';
import { env } from '../../config/env.js';
import { logger } from '../logger.js';
import { renderTemplate } from './templates.js';
import type { ProviderSendInput, ProviderSendResult } from './types.js';

export interface EmailProvider {
  readonly mode: 'stub' | 'resend' | 'smtp' | 'msg91';
  send(input: ProviderSendInput): Promise<ProviderSendResult>;
}

/** Outbound HTTP ceiling: the dispatch worker must never hang on a provider. */
const HTTP_TIMEOUT_MS = 15_000;

/** `"Circls <no-reply@circls.app>"` → `{ name, address }`; a bare address → `{ address }`. */
export function parseFromAddress(from: string): { address: string; name?: string } {
  const m = /^\s*(.*?)\s*<([^<>]+)>\s*$/.exec(from);
  if (m && m[2]) {
    const name = m[1]?.replace(/^"|"$/g, '').trim();
    return name ? { address: m[2].trim(), name } : { address: m[2].trim() };
  }
  return { address: from.trim() };
}

/**
 * MSG91 Email. https://docs.msg91.com/email/send-email
 *
 * MSG91 only sends through templates stored (and approved) in its dashboard,
 * so one generic transactional template carries every email: subject
 * `Circls: {{VAR1}}`, body `{{VAR2}}` inside a <pre> (docs/EMAIL_SETUP.md).
 * We render our plain-text template as usual and send it as those two
 * variables — also as `subject`/`body`, for a template that renamed them.
 *
 * POST https://control.msg91.com/api/v5/email/send with `authkey: <key>`:
 *   { recipients: [{ to: [{ email }], variables }], from: { email, name },
 *     domain, template_id }
 * Returns `{ status: 'success', hasError: false, data: { unique_id } }`; a
 * rejected request answers with `hasError: true` (sometimes still HTTP 200).
 */
class Msg91Email implements EmailProvider {
  readonly mode = 'msg91' as const;
  private readonly from: { address: string; name?: string };

  constructor(
    private readonly authKey: string,
    from: string,
    private readonly domain: string,
    private readonly templateId: string,
  ) {
    this.from = parseFromAddress(from);
  }

  async send(input: ProviderSendInput): Promise<ProviderSendResult> {
    const rendered = renderTemplate('email', input.templateKey, input.payload);
    const subject = rendered.subject ?? '(no subject)';

    const res = await fetch('https://control.msg91.com/api/v5/email/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        authkey: this.authKey,
      },
      body: JSON.stringify({
        recipients: [
          {
            to: [{ email: input.recipient }],
            variables: { VAR1: subject, VAR2: rendered.body, subject, body: rendered.body },
          },
        ],
        from: { email: this.from.address, ...(this.from.name ? { name: this.from.name } : {}) },
        domain: this.domain,
        template_id: this.templateId,
      }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });

    const text = await res.text().catch(() => '');
    if (!res.ok) {
      throw new Error(`msg91_email_send_failed:${res.status}:${text.slice(0, 200)}`);
    }
    let json: { hasError?: boolean; data?: { unique_id?: string } } = {};
    try {
      json = JSON.parse(text) as typeof json;
    } catch {
      // Non-JSON 200 — treat as accepted without an id.
    }
    if (json.hasError) {
      throw new Error(`msg91_email_send_failed:${res.status}:${text.slice(0, 200)}`);
    }
    return { providerMessageId: json.data?.unique_id ?? undefined };
  }
}

/**
 * MSG91 Email when its from address and template are set (with the shared
 * MSG91_AUTH_KEY). The auth key alone means SMS only. Setting one email var
 * without the rest is an operator mistake: warn in dev, fail the boot in prod.
 */
function resolveMsg91Email(): EmailProvider | null {
  const { MSG91_AUTH_KEY, MSG91_EMAIL_FROM, MSG91_EMAIL_TEMPLATE_ID, MSG91_EMAIL_DOMAIN } = env;
  if (!MSG91_EMAIL_FROM && !MSG91_EMAIL_TEMPLATE_ID) return null;
  if (MSG91_AUTH_KEY && MSG91_EMAIL_FROM && MSG91_EMAIL_TEMPLATE_ID) {
    const domain = MSG91_EMAIL_DOMAIN ?? parseFromAddress(MSG91_EMAIL_FROM).address.split('@')[1] ?? '';
    return new Msg91Email(MSG91_AUTH_KEY, MSG91_EMAIL_FROM, domain, MSG91_EMAIL_TEMPLATE_ID);
  }
  logger.warn(
    {
      hasAuthKey: Boolean(MSG91_AUTH_KEY),
      hasFrom: Boolean(MSG91_EMAIL_FROM),
      hasTemplate: Boolean(MSG91_EMAIL_TEMPLATE_ID),
    },
    'msg91_email_partial_config — set MSG91_AUTH_KEY, MSG91_EMAIL_FROM and MSG91_EMAIL_TEMPLATE_ID to send email through MSG91',
  );
  if (env.NODE_ENV === 'production') {
    throw new Error(
      'msg91_email_partial_config: MSG91_AUTH_KEY, MSG91_EMAIL_FROM and MSG91_EMAIL_TEMPLATE_ID are all required in production',
    );
  }
  return null;
}

class StubEmail implements EmailProvider {
  readonly mode = 'stub' as const;
  async send(input: ProviderSendInput): Promise<ProviderSendResult> {
    const rendered = renderTemplate('email', input.templateKey, input.payload);
    logger.info(
      {
        to: input.recipient,
        tpl: input.templateKey,
        subject: rendered.subject,
      },
      'email_stub',
    );
    return { providerMessageId: `stub_email_${Date.now()}` };
  }
}

/**
 * Local sandbox only. Delivers to a local SMTP sink (Mailpit) so non-dev team
 * members can read the exact rendered email at the Mailpit web inbox instead of
 * it being silently logged. Selected when SANDBOX_SMTP_HOST is set.
 */
class SmtpEmail implements EmailProvider {
  readonly mode = 'smtp' as const;
  private readonly transport: ReturnType<typeof nodemailer.createTransport>;
  constructor(
    host: string,
    port: number,
    private readonly from: string,
  ) {
    this.transport = nodemailer.createTransport({ host, port, secure: false });
  }
  async send(input: ProviderSendInput): Promise<ProviderSendResult> {
    const rendered = renderTemplate('email', input.templateKey, input.payload);
    const info = await this.transport.sendMail({
      from: this.from,
      to: input.recipient,
      subject: rendered.subject ?? '(no subject)',
      text: rendered.body,
    });
    return { providerMessageId: info.messageId };
  }
}

/**
 * Resend transactional email. https://resend.com/docs/api-reference/emails/send-email
 * POST https://api.resend.com/emails with bearer token, body:
 *   { from, to, subject, text }
 * Returns `{ id: "<message id>" }`.
 *
 * We send plain text bodies; HTML rendering moves to a per-tenant theme later.
 */
class ResendEmail implements EmailProvider {
  readonly mode = 'resend' as const;
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(input: ProviderSendInput): Promise<ProviderSendResult> {
    const rendered = renderTemplate('email', input.templateKey, input.payload);

    const body = {
      from: this.from,
      to: [input.recipient],
      subject: rendered.subject ?? '(no subject)',
      text: rendered.body,
    };

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`resend_send_failed:${res.status}:${text.slice(0, 200)}`);
    }

    const json = (await res.json().catch(() => ({}))) as { id?: string };
    return { providerMessageId: json.id ?? undefined };
  }
}

export function getEmailProvider(): EmailProvider {
  // Local sandbox short-circuit: deliver to the Mailpit SMTP sink.
  if (env.SANDBOX_SMTP_HOST) {
    return new SmtpEmail(env.SANDBOX_SMTP_HOST, env.SANDBOX_SMTP_PORT, env.RESEND_FROM ?? 'Circls Sandbox <no-reply@sandbox.local>');
  }

  // MSG91 Email, when configured, sends everything; Resend stays the fallback.
  const msg91 = resolveMsg91Email();
  if (msg91) return msg91;

  const { RESEND_API_KEY, RESEND_FROM } = env;

  // Fully configured → real delivery.
  if (RESEND_API_KEY && RESEND_FROM) {
    return new ResendEmail(RESEND_API_KEY, RESEND_FROM);
  }

  // Partially configured → exactly one of the two is set. This is almost
  // certainly an operator mistake (they meant to enable email but missed a
  // var). Falling through to the stub silently is the original trap that made
  // email "not work" with no signal.
  if (RESEND_API_KEY || RESEND_FROM) {
    logger.warn(
      { hasKey: Boolean(RESEND_API_KEY), hasFrom: Boolean(RESEND_FROM) },
      'resend_partial_config — set BOTH RESEND_API_KEY and RESEND_FROM to enable real email',
    );
    // Fail fast in prod: a half-configured sender is an operator mistake and
    // we'd rather crash the deploy than silently swallow every email. Dev/test
    // stay forgiving and fall through to the stub below.
    if (env.NODE_ENV === 'production') {
      throw new Error(
        'resend_partial_config: both RESEND_API_KEY and RESEND_FROM are required in production',
      );
    }
  }

  // Nothing configured → stub (expected in dev/test).
  return new StubEmail();
}
