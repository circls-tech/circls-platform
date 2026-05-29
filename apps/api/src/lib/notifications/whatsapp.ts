import { env } from '../../config/env.js';
import { logger } from '../logger.js';
import { renderTemplate } from './templates.js';
import type { ProviderSendInput, ProviderSendResult } from './types.js';

export interface WhatsappProvider {
  readonly mode: 'stub' | 'aisensy' | 'gupshup';
  send(input: ProviderSendInput): Promise<ProviderSendResult>;
}

class StubWhatsapp implements WhatsappProvider {
  readonly mode = 'stub' as const;
  async send(input: ProviderSendInput): Promise<ProviderSendResult> {
    const rendered = renderTemplate('whatsapp', input.templateKey, input.payload);
    logger.info(
      { to: input.recipient, tpl: input.templateKey, body: rendered.body },
      'whatsapp_stub',
    );
    return { providerMessageId: `stub_wa_${Date.now()}` };
  }
}

/**
 * Live WhatsApp via AiSensy or Gupshup. Both expose a campaign-style POST
 * endpoint; we render our internal template body, then send it as a single
 * `bodyValues[0]` parameter to whichever WA template the customer has
 * pre-approved. Real DLT/template approval is a per-tenant ops job — Phase 13
 * just exercises the HTTP path.
 *
 *   AiSensy:  POST https://backend.aisensy.com/campaign/t1/api/v2
 *             body: { apiKey, campaignName, destination, userName, source,
 *                     templateParams: [body] }
 *
 *   Gupshup:  POST https://api.gupshup.io/wa/api/v1/msg
 *             form-encoded: channel=whatsapp, source=<senderNumber>,
 *                           destination=<number>, message={text:"..."}
 *             apikey header.
 */
class LiveWhatsapp implements WhatsappProvider {
  constructor(
    public readonly mode: 'aisensy' | 'gupshup',
    private readonly apiKey: string,
  ) {}

  async send(input: ProviderSendInput): Promise<ProviderSendResult> {
    const rendered = renderTemplate('whatsapp', input.templateKey, input.payload);
    return this.mode === 'aisensy'
      ? this.sendAisensy(input.recipient, input.templateKey, rendered.body)
      : this.sendGupshup(input.recipient, rendered.body);
  }

  private async sendAisensy(
    recipient: string,
    templateKey: string,
    body: string,
  ): Promise<ProviderSendResult> {
    const reqBody = {
      apiKey: this.apiKey,
      campaignName: templateKey,
      destination: recipient,
      userName: 'Circls',
      source: 'api',
      templateParams: [body],
    };

    const res = await fetch('https://backend.aisensy.com/campaign/t1/api/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reqBody),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`aisensy_send_failed:${res.status}:${text.slice(0, 200)}`);
    }
    const json = (await res.json().catch(() => ({}))) as { messageId?: string };
    return { providerMessageId: json.messageId ?? undefined };
  }

  private async sendGupshup(
    recipient: string,
    body: string,
  ): Promise<ProviderSendResult> {
    // Gupshup wants the destination without '+'.
    const dest = recipient.startsWith('+') ? recipient.slice(1) : recipient;
    const form = new URLSearchParams({
      channel: 'whatsapp',
      source: '917000000000', // placeholder; per-tenant senders are deploy-time config
      destination: dest,
      'src.name': 'circls',
      message: JSON.stringify({ type: 'text', text: body }),
    });

    const res = await fetch('https://api.gupshup.io/wa/api/v1/msg', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        apikey: this.apiKey,
      },
      body: form.toString(),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`gupshup_send_failed:${res.status}:${text.slice(0, 200)}`);
    }
    const json = (await res.json().catch(() => ({}))) as { messageId?: string };
    return { providerMessageId: json.messageId ?? undefined };
  }
}

export function getWhatsappProvider(): WhatsappProvider {
  if (env.WHATSAPP_PROVIDER && env.WHATSAPP_API_KEY) {
    return new LiveWhatsapp(env.WHATSAPP_PROVIDER, env.WHATSAPP_API_KEY);
  }
  return new StubWhatsapp();
}
