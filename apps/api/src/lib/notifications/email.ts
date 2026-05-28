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
    private readonly from: string | undefined,
  ) {}

  async send(input: ProviderSendInput): Promise<ProviderSendResult> {
    const rendered = renderTemplate('email', input.templateKey, input.payload);
    if (!this.from) {
      throw new Error('resend_send_failed:RESEND_FROM not configured');
    }

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
  if (env.RESEND_API_KEY) return new ResendEmail(env.RESEND_API_KEY, env.RESEND_FROM);
  return new StubEmail();
}
