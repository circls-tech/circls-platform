import { env } from '../../config/env.js';
import { logger } from '../logger.js';
import type { ProviderSendInput, ProviderSendResult } from './types.js';

export interface WhatsappProvider {
  readonly mode: 'stub' | 'aisensy' | 'gupshup';
  send(input: ProviderSendInput): Promise<ProviderSendResult>;
}

class StubWhatsapp implements WhatsappProvider {
  readonly mode = 'stub' as const;
  async send(input: ProviderSendInput): Promise<ProviderSendResult> {
    logger.info({ to: input.recipient, tpl: input.templateKey }, 'whatsapp_stub');
    return { providerMessageId: `stub_wa_${Date.now()}` };
  }
}

class LiveWhatsapp implements WhatsappProvider {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(public readonly mode: 'aisensy' | 'gupshup', private readonly apiKey: string) {}
  async send(_input: ProviderSendInput): Promise<ProviderSendResult> {
    throw new Error(`${this.mode}.send not implemented — phase 13`);
  }
}

export function getWhatsappProvider(): WhatsappProvider {
  if (env.WHATSAPP_PROVIDER && env.WHATSAPP_API_KEY) {
    return new LiveWhatsapp(env.WHATSAPP_PROVIDER, env.WHATSAPP_API_KEY);
  }
  return new StubWhatsapp();
}
