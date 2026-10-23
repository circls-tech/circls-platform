import nodemailer from 'nodemailer';
import { env } from '../../config/env.js';
import { logger } from '../logger.js';
import { isInternalTemplateKey } from './templates.js';
import { emailVariables, getEmailDesign, msg91TemplateId, renderEmail } from './email_designs/index.js';
import type { ProviderSendInput, ProviderSendResult } from './types.js';

/**
 * Email channel. Two audiences, two senders:
 *
 *   - **external** — every email to a customer or partner (booking
 *     confirmations, question replies, team invitations, …). Sent through
 *     MSG91 Email, on the same account (and auth key) as MSG91 SMS.
 *   - **internal** — mail to the Circls admin team only: listing-review
 *     requests, new-org sign-ups, payout reminders
 *     and the daily summary. These are the `admin.*` templates. Sent through
 *     Resend, whose free tier covers that volume.
 *
 * The dispatcher sees ONE provider (`getEmailProvider()`); it routes each send
 * by template key, which is the one field that survives the round trip through
 * the `notifications` table for scheduled rows. Each sender falls back to the
 * other when only one is configured, so a deploy that has Resend but not yet
 * MSG91 Email (or the reverse) still delivers everything — with a boot warning.
 *
 * Content comes from `renderEmail()` (./email_designs): designed emails are
 * branded HTML + a text alternative, the rest plain text. Senders that take
 * finished content (SMTP, Resend) get both; MSG91 instead renders its own
 * stored copy of each design from the variables we send.
 */

/** Reply-To for every sender, when EMAIL_REPLY_TO is set. */
const replyTo = (): string | undefined => env.EMAIL_REPLY_TO;

export type EmailProviderMode = 'stub' | 'smtp' | 'resend' | 'msg91';

export interface EmailProvider {
  readonly mode: EmailProviderMode;
  send(input: ProviderSendInput): Promise<ProviderSendResult>;
}

/** What `getEmailProvider()` returns: the router plus its two senders. */
export interface EmailRouter extends EmailProvider {
  /** Sender for customer/partner mail. `mode` mirrors this one. */
  readonly external: EmailProvider;
  /** Sender for admin-team mail (`admin.*` templates). */
  readonly internal: EmailProvider;
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

class StubEmail implements EmailProvider {
  readonly mode = 'stub' as const;
  async send(input: ProviderSendInput): Promise<ProviderSendResult> {
    // Render so a broken template fails the same way in stub + live mode.
    const rendered = renderEmail(input.templateKey, input.payload);
    logger.info(
      {
        to: input.recipient,
        tpl: input.templateKey,
        audience: isInternalTemplateKey(input.templateKey) ? 'internal' : 'external',
        subject: rendered.subject,
        designed: Boolean(rendered.html),
      },
      'email_stub',
    );
    return { providerMessageId: `stub_email_${Date.now()}` };
  }
}

/**
 * Local sandbox only. Delivers to a local SMTP sink (Mailpit) so non-dev team
 * members can read the exact rendered email at the Mailpit web inbox instead of
 * it being silently logged. Selected when SANDBOX_SMTP_HOST is set — for both
 * audiences, so the admin alerts show up in Mailpit too.
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
    const rendered = renderEmail(input.templateKey, input.payload);
    const info = await this.transport.sendMail({
      from: this.from,
      to: input.recipient,
      subject: rendered.subject,
      text: rendered.text,
      ...(rendered.html ? { html: rendered.html } : {}),
      ...(replyTo() ? { replyTo: replyTo() } : {}),
    });
    return { providerMessageId: info.messageId };
  }
}

/**
 * MSG91 Email — the customer/partner sender.
 * https://docs.msg91.com/email/send-email
 *
 * MSG91 only sends through templates stored in its dashboard, and renders
 * them itself (Handlebars). Two kinds:
 *   - A designed email has its own template (slug in ./email_designs, or the
 *     MSG91_EMAIL_TEMPLATES override); we send `emailVariables(payload)` and
 *     MSG91 fills in the design.
 *   - Everything else goes through the generic template
 *     (MSG91_EMAIL_TEMPLATE_ID): subject `Circls: {{VAR1}}`, body `{{VAR2}}`
 *     in a `<pre>`. We render the plain-text template here and send it as
 *     those two variables (also as `subject`/`body`, for a template that
 *     renamed them).
 *
 * POST https://control.msg91.com/api/v5/email/send with `authkey: <key>`:
 *   { recipients: [{ to: [{ email }], variables }], from: { email, name },
 *     domain, template_id, reply_to? }
 * Returns `{ status: 'success', hasError: false, data: { unique_id } }`;
 * a rejected request answers with `hasError: true` (sometimes still 200).
 */
class Msg91Email implements EmailProvider {
  readonly mode = 'msg91' as const;
  private readonly from: { address: string; name?: string };

  constructor(
    private readonly authKey: string,
    from: string,
    private readonly domain: string,
    private readonly genericTemplateId: string,
  ) {
    this.from = parseFromAddress(from);
  }

  async send(input: ProviderSendInput): Promise<ProviderSendResult> {
    const designTemplateId = msg91TemplateId(input.templateKey);
    let templateId: string;
    let variables: Record<string, unknown>;
    if (designTemplateId) {
      // Fail here, like the other senders, if the design itself is broken.
      if (getEmailDesign(input.templateKey)) renderEmail(input.templateKey, input.payload);
      templateId = designTemplateId;
      variables = emailVariables(input.payload);
    } else {
      const rendered = renderEmail(input.templateKey, input.payload);
      templateId = this.genericTemplateId;
      // MSG91 names a template's variables VAR1, VAR2, … unless renamed, so
      // the subject and body go out under both names.
      variables = {
        subject: rendered.subject,
        body: rendered.text,
        VAR1: rendered.subject,
        VAR2: rendered.text,
      };
    }

    const reply = replyTo();
    const body = {
      recipients: [{ to: [{ email: input.recipient }], variables }],
      from: { email: this.from.address, ...(this.from.name ? { name: this.from.name } : {}) },
      domain: this.domain,
      template_id: templateId,
      ...(reply ? { reply_to: [{ email: reply }] } : {}),
    };

    const res = await fetch('https://control.msg91.com/api/v5/email/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        authkey: this.authKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });

    const text = await res.text().catch(() => '');
    if (!res.ok) {
      throw new Error(`msg91_email_send_failed:${res.status}:${text.slice(0, 200)}`);
    }

    let json: { hasError?: boolean; message?: string; data?: { unique_id?: string } } = {};
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
 * Resend transactional email — the admin-team sender.
 * https://resend.com/docs/api-reference/emails/send-email
 * POST https://api.resend.com/emails with bearer token, body:
 *   { from, to, subject, text, html?, reply_to? }
 * Returns `{ id: "<message id>" }`.
 */
class ResendEmail implements EmailProvider {
  readonly mode = 'resend' as const;
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(input: ProviderSendInput): Promise<ProviderSendResult> {
    const rendered = renderEmail(input.templateKey, input.payload);
    const reply = replyTo();

    const body = {
      from: this.from,
      to: [input.recipient],
      subject: rendered.subject,
      text: rendered.text,
      ...(rendered.html ? { html: rendered.html } : {}),
      ...(reply ? { reply_to: reply } : {}),
    };

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`resend_send_failed:${res.status}:${text.slice(0, 200)}`);
    }

    const json = (await res.json().catch(() => ({}))) as { id?: string };
    return { providerMessageId: json.id ?? undefined };
  }
}

/** Picks the sender by audience; `admin.*` templates are internal. */
class RoutingEmail implements EmailRouter {
  constructor(
    readonly external: EmailProvider,
    readonly internal: EmailProvider,
  ) {}
  get mode(): EmailProviderMode {
    return this.external.mode;
  }
  send(input: ProviderSendInput): Promise<ProviderSendResult> {
    const provider = isInternalTemplateKey(input.templateKey) ? this.internal : this.external;
    return provider.send(input);
  }
}

/**
 * A partially configured sender — some of its variables set, not all — is
 * almost certainly an operator mistake (they meant to enable email but missed
 * a var). Falling through silently is the original trap that made email "not
 * work" with no signal, so: warn in dev/test and fail the boot in production.
 */
function partialConfig(label: 'msg91_email' | 'resend', vars: Record<string, string | undefined>): void {
  const missing = Object.entries(vars)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  const all = Object.keys(vars).join(', ');
  logger.warn({ missing }, `${label}_partial_config — set ALL of ${all} to enable real email`);
  if (env.NODE_ENV === 'production') {
    throw new Error(`${label}_partial_config: ${all} are all required in production`);
  }
}

/**
 * MSG91 Email needs the shared auth key plus a from address and the template
 * id. The auth key alone means "SMS only", not a half-configured email sender;
 * once either email var is set, all three must be.
 */
function resolveMsg91Email(): EmailProvider | null {
  const { MSG91_AUTH_KEY, MSG91_EMAIL_FROM, MSG91_EMAIL_TEMPLATE_ID, MSG91_EMAIL_DOMAIN } = env;
  if (!MSG91_EMAIL_FROM && !MSG91_EMAIL_TEMPLATE_ID) return null;
  if (MSG91_AUTH_KEY && MSG91_EMAIL_FROM && MSG91_EMAIL_TEMPLATE_ID) {
    // The DKIM-signing domain is the from address's unless overridden (e.g. a
    // registered subdomain with a from address on it).
    const domain = MSG91_EMAIL_DOMAIN ?? parseFromAddress(MSG91_EMAIL_FROM).address.split('@')[1] ?? '';
    return new Msg91Email(MSG91_AUTH_KEY, MSG91_EMAIL_FROM, domain, MSG91_EMAIL_TEMPLATE_ID);
  }
  partialConfig('msg91_email', { MSG91_AUTH_KEY, MSG91_EMAIL_FROM, MSG91_EMAIL_TEMPLATE_ID });
  return null;
}

function resolveResend(): EmailProvider | null {
  const { RESEND_API_KEY, RESEND_FROM } = env;
  if (RESEND_API_KEY && RESEND_FROM) return new ResendEmail(RESEND_API_KEY, RESEND_FROM);
  if (RESEND_API_KEY || RESEND_FROM) partialConfig('resend', { RESEND_API_KEY, RESEND_FROM });
  return null;
}

export function getEmailProvider(): EmailRouter {
  // Local sandbox short-circuit: deliver everything to the Mailpit SMTP sink.
  if (env.SANDBOX_SMTP_HOST) {
    const smtp = new SmtpEmail(
      env.SANDBOX_SMTP_HOST,
      env.SANDBOX_SMTP_PORT,
      env.MSG91_EMAIL_FROM ?? env.RESEND_FROM ?? 'Circls Sandbox <no-reply@sandbox.local>',
    );
    return new RoutingEmail(smtp, smtp);
  }

  const msg91 = resolveMsg91Email();
  const resend = resolveResend();

  // Customer/partner mail: MSG91. Until it is configured, Resend keeps that
  // mail flowing so no confirmation is dropped during the switch-over —
  // loudly, since Resend's quota is sized for the admin mail only.
  let external: EmailProvider;
  if (msg91) {
    external = msg91;
  } else if (resend) {
    logger.warn('msg91_email_not_configured — customer/partner email is going through Resend; set MSG91_AUTH_KEY + MSG91_EMAIL_FROM + MSG91_EMAIL_TEMPLATE_ID');
    external = resend;
  } else {
    external = new StubEmail();
  }

  // Admin-team mail: Resend. Low volume, so MSG91 can carry it meanwhile.
  let internal: EmailProvider;
  if (resend) {
    internal = resend;
  } else if (msg91) {
    logger.warn('resend_not_configured — admin-team email is going through MSG91; set RESEND_API_KEY + RESEND_FROM');
    internal = msg91;
  } else {
    internal = new StubEmail();
  }

  // Nothing configured → both stub (expected in dev/test).
  return new RoutingEmail(external, internal);
}
