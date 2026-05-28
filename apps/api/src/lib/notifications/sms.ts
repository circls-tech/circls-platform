import { env } from '../../config/env.js';
import { logger } from '../logger.js';
import type { ProviderSendInput, ProviderSendResult } from './types.js';

export interface SmsProvider {
  readonly mode: 'stub' | 'msg91';
  send(input: ProviderSendInput): Promise<ProviderSendResult>;
}

class StubSms implements SmsProvider {
  readonly mode = 'stub' as const;
  async send(input: ProviderSendInput): Promise<ProviderSendResult> {
    logger.info({ to: input.recipient, tpl: input.templateKey }, 'sms_stub');
    return { providerMessageId: `stub_sms_${Date.now()}` };
  }
}

class Msg91Sms implements SmsProvider {
  readonly mode = 'msg91' as const;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(private readonly authKey: string, private readonly senderId: string | undefined) {}
  async send(_input: ProviderSendInput): Promise<ProviderSendResult> {
    throw new Error('Msg91Sms.send not implemented — phase 13');
  }
}

export function getSmsProvider(): SmsProvider {
  if (env.MSG91_AUTH_KEY) return new Msg91Sms(env.MSG91_AUTH_KEY, env.MSG91_SENDER_ID);
  return new StubSms();
}
