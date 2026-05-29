import { env } from '../../config/env.js';
import { logger } from '../logger.js';
import { renderTemplate } from './templates.js';
import type { ProviderSendInput, ProviderSendResult } from './types.js';

export interface EmailProvider {
  readonly mode: 'stub' | 'resend';
  send(input: ProviderSendInput): Promise<ProviderSendResult>;
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
