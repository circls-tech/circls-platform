import { env } from '../../config/env.js';
import { logger } from '../logger.js';
import { renderTemplate } from './templates.js';
import type { ProviderSendInput, ProviderSendResult } from './types.js';

export interface SmsProvider {
  readonly mode: 'stub' | 'msg91';
  send(input: ProviderSendInput): Promise<ProviderSendResult>;
}

class StubSms implements SmsProvider {
  readonly mode = 'stub' as const;
  async send(input: ProviderSendInput): Promise<ProviderSendResult> {
    // Render so a broken template fails the same way in stub + live mode.
    const rendered = renderTemplate('sms', input.templateKey, input.payload);
    logger.info(
      { to: input.recipient, tpl: input.templateKey, body: rendered.body },
      'sms_stub',
    );
    return { providerMessageId: `stub_sms_${Date.now()}` };
  }
}

/**
 * MSG91 "simple-text" flow. We POST to /api/v5/flow/ with the auth key in the
 * `authkey` header. The body shape is what MSG91 documents for plain SMS:
 *   {
 *     "flow_id":  "<configured flow id, optional in simple-text>",
 *     "sender":   "<senderId>",
 *     "short_url": "0",
 *     "recipients": [{ "mobiles": "<E.164 sans +>", "VAR1": "<body>" }]
 *   }
 *
 * In a production rollout we'd wire each templateKey to a separate MSG91 flow
 * id (DLT requirement) — that's a deploy-time concern. For Phase 13 we send
 * the rendered body as VAR1 and let MSG91 substitute into a single generic
 * "simple text" flow on the dashboard side.
 */
class Msg91Sms implements SmsProvider {
  readonly mode = 'msg91' as const;
  constructor(
    private readonly authKey: string,
    private readonly senderId: string | undefined,
  ) {}

  async send(input: ProviderSendInput): Promise<ProviderSendResult> {
    const rendered = renderTemplate('sms', input.templateKey, input.payload);
    // MSG91 wants the E.164 number without the leading `+`.
    const mobile = input.recipient.startsWith('+')
      ? input.recipient.slice(1)
      : input.recipient;

    const body: Record<string, unknown> = {
      flow_id: input.templateKey, // tenant configures one MSG91 flow per key
      sender: this.senderId ?? '',
      short_url: '0',
      recipients: [
        {
          mobiles: mobile,
          VAR1: rendered.body,
        },
      ],
    };

    const res = await fetch('https://control.msg91.com/api/v5/flow/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authkey: this.authKey,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`msg91_send_failed:${res.status}:${text.slice(0, 200)}`);
    }

    // MSG91 returns { type: 'success', message: '<requestId>' }.
    const json = (await res.json().catch(() => ({}))) as { message?: string };
    return { providerMessageId: json.message ?? undefined };
  }
}

export function getSmsProvider(): SmsProvider {
  if (env.MSG91_AUTH_KEY) return new Msg91Sms(env.MSG91_AUTH_KEY, env.MSG91_SENDER_ID);
  return new StubSms();
}
