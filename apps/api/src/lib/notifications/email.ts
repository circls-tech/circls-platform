import { env } from '../../config/env.js';
import { logger } from '../logger.js';
import type { ProviderSendInput, ProviderSendResult } from './types.js';

export interface EmailProvider {
  readonly mode: 'stub' | 'resend';
  send(input: ProviderSendInput): Promise<ProviderSendResult>;
}

class StubEmail implements EmailProvider {
  readonly mode = 'stub' as const;
  async send(input: ProviderSendInput): Promise<ProviderSendResult> {
    logger.info({ to: input.recipient, tpl: input.templateKey }, 'email_stub');
    return { providerMessageId: `stub_email_${Date.now()}` };
  }
}

class ResendEmail implements EmailProvider {
  readonly mode = 'resend' as const;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(private readonly apiKey: string, private readonly from: string | undefined) {}
  async send(_input: ProviderSendInput): Promise<ProviderSendResult> {
    throw new Error('ResendEmail.send not implemented — phase 13');
  }
}

export function getEmailProvider(): EmailProvider {
  if (env.RESEND_API_KEY) return new ResendEmail(env.RESEND_API_KEY, env.RESEND_FROM);
  return new StubEmail();
}
