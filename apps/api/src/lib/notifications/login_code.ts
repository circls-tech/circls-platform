import { env } from '../../config/env.js';
import { logger } from '../logger.js';

/**
 * Texts a consumer login code that Circls generated and will check itself
 * (services/phone_login_service.ts). Only Indian numbers come through here;
 * the rest sign in with Firebase phone auth.
 */
export interface LoginCodeSender {
  readonly mode: 'stub' | 'msg91';
  /** Resolves with MSG91's request id when there is one; throws when the send failed. */
  send(input: { phoneE164: string; code: string; ttlMinutes: number }): Promise<{ requestId?: string }>;
}

/** MSG91 can be slow; a sign-in waits on this call, so don't wait long. */
const SEND_TIMEOUT_MS = 8_000;

class StubLoginCodeSender implements LoginCodeSender {
  readonly mode = 'stub' as const;
  async send(input: { phoneE164: string; code: string }): Promise<{ requestId?: string }> {
    // Never in production (env refuses MSG91_OTP_ENABLED without the keys), so
    // logging the code is how the sandbox reads it, like the `sms_stub` line.
    logger.info({ to: input.phoneE164, code: input.code }, 'login_code_stub');
    return {};
  }
}

/**
 * MSG91 SendOTP: `POST /api/v5/otp` with the template, the number (country
 * code, no `+`) and our own code in `otp`, so MSG91 only delivers — Circls
 * stores and checks the code and never calls MSG91's Verify OTP. The template
 * is the DLT-registered OTP template from MSG91 → OTP; its text holds ##OTP##.
 * MSG91 answers HTTP 200 with `type: "error"` for a bad template or number,
 * so `type` decides, not the status.
 */
class Msg91LoginCodeSender implements LoginCodeSender {
  readonly mode = 'msg91' as const;
  constructor(
    private readonly authKey: string,
    private readonly templateId: string,
  ) {}

  async send(input: { phoneE164: string; code: string; ttlMinutes: number }): Promise<{ requestId?: string }> {
    const query = new URLSearchParams({
      template_id: this.templateId,
      mobile: input.phoneE164.replace(/^\+/, ''),
      otp: input.code,
      otp_length: String(input.code.length),
      otp_expiry: String(input.ttlMinutes),
    });
    const res = await fetch(`https://control.msg91.com/api/v5/otp?${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authkey: this.authKey },
      body: '{}',
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    const json = (await res.json().catch(() => ({}))) as {
      type?: string;
      message?: string;
      request_id?: string;
    };
    if (!res.ok || json.type !== 'success') {
      throw new Error(`msg91_otp_send_failed:${res.status}:${(json.message ?? '').slice(0, 200)}`);
    }
    return json.request_id ? { requestId: json.request_id } : {};
  }
}

export function getLoginCodeSender(): LoginCodeSender {
  if (env.MSG91_AUTH_KEY && env.MSG91_OTP_TEMPLATE_ID) {
    return new Msg91LoginCodeSender(env.MSG91_AUTH_KEY, env.MSG91_OTP_TEMPLATE_ID);
  }
  return new StubLoginCodeSender();
}
