/**
 * Notification template engine. Phase 13 (Track B).
 *
 * Hardcoded English templates with simple `{{var}}` substitution. Each entry
 * is keyed by `templateKey` and has a per-channel rendering shape:
 *   - sms       → `{ body }`
 *   - email     → `{ subject, body }`
 *   - whatsapp  → `{ body }`
 *
 * The dispatcher passes `(channel, templateKey, payload)` to `renderTemplate`
 * which returns whichever shape the channel needs. Unknown keys / channels
 * throw — the worker catches and marks the row failed so a broken template
 * doesn't silently swallow notifications.
 *
 * NOTE: keep templates short. SMS in particular has a per-message char cap
 * once we move off MSG91's simple-text flow; for now we're rendering one row
 * of SMS body and trusting MSG91 to fragment.
 */

export type NotificationChannel = 'sms' | 'email' | 'whatsapp';

/**
 * Templates under this prefix are internal mail to the Circls admin team and
 * go out through the internal email sender (Resend); every other template is
 * customer/partner mail (MSG91 Email). The key is the one field that survives
 * a scheduled row's round trip through the `notifications` table, which is
 * why the audience lives in the key and not in a separate dispatch flag.
 * See lib/notifications/email.ts.
 */
export const INTERNAL_TEMPLATE_PREFIX = 'admin.';

export function isInternalTemplateKey(templateKey: string): boolean {
  return templateKey.startsWith(INTERNAL_TEMPLATE_PREFIX);
}

export interface RenderedTemplate {
  /** Email only — always undefined for sms/whatsapp. */
  subject?: string;
  body: string;
}

interface ChannelTemplate {
  subject?: string;
  body: string;
}

interface TemplateDef {
  sms?: ChannelTemplate;
  email?: ChannelTemplate;
  whatsapp?: ChannelTemplate;
}

/**
 * Static, hardcoded English templates. When we move to per-tenant copy this
 * becomes a DB-backed lookup; the call site doesn't change.
 *
 * Variable contract (what the dispatcher passes in `payload`):
 *   booking.*          → itemName ("Venue · Arena", the event, the plan), when,
 *                        details (pre-rendered lines with no empty rows),
 *                        bookingId, customerName — see basePayload /
 *                        bookingSummary in services/notification_payloads.ts;
 *                        booking.refunded also has amount
 *   otp.login          → code
 *   tenant.invitation  → tenantName, inviterName, role, inviteUrl, expiresAtIso
 *   question.asked     → subjectName, excerpt, visibility, portalUrl
 *   question.replied   → subjectName, excerpt, authorName, link
 *   admin.daily_digest → dateLabel, summary (pre-rendered text)
 *
 * Emails with a design (booking confirmed/cancelled/refunded, the partner and
 * admin emails) render from ./email_designs instead; their variables are
 * documented next to each design.
 */
const TEMPLATES: Record<string, TemplateDef> = {
  'booking.confirmed': {
    sms: {
      body: 'Circls: Your booking for {{itemName}} on {{when}} is confirmed. Ref {{bookingId}}.',
    },
    // email: the designed template in ./email_designs/consumer.ts.
    whatsapp: {
      body: 'Booking confirmed: *{{itemName}}* — {{when}}. Ref: {{bookingId}}.',
    },
  },

  'booking.cancelled': {
    sms: {
      body: 'Circls: Your booking for {{itemName}} on {{when}} has been cancelled. Ref {{bookingId}}.',
    },
    // email: the designed template in ./email_designs/consumer.ts.
  },

  // SMS only: the organiser called the whole event off. The booking itself
  // stays confirmed until the organiser refunds it, so this doesn't say the
  // booking was cancelled. (The email is booking.cancelled in event mode.)
  'booking.event_cancelled': {
    sms: {
      body: 'Circls: {{itemName}} on {{when}} has been cancelled by the organiser. Your refund comes from them. Ref {{bookingId}}.',
    },
  },

  // Rescheduling moves court slots; no design yet, so the email is plain text.
  'booking.rescheduled': {
    sms: {
      body: 'Circls: Your booking for {{itemName}} has moved to {{when}}. Ref {{bookingId}}.',
    },
    email: {
      subject: 'Booking moved — {{itemName}}',
      body:
        'Hi {{customerName}},\n\n' +
        'Your booking has been moved. Here are the new details.\n\n' +
        '{{details}}\n' +
        'Booking ref: {{bookingId}}\n\n' +
        'If this time does not suit you, reply to the venue or cancel from your bookings.\n— Circls',
    },
    whatsapp: {
      body: 'Your booking for *{{itemName}}* has moved to {{when}}. Ref: {{bookingId}}.',
    },
  },

  'booking.refunded': {
    sms: {
      body: 'Circls: A refund of {{amount}} for your booking for {{itemName}} has been issued. Ref {{bookingId}}.',
    },
    // email: the designed template in ./email_designs/consumer.ts.
  },

  'booking.reminder_t24h': {
    sms: {
      body: 'Circls reminder: Your booking for {{itemName}} is tomorrow — {{when}}.',
    },
    whatsapp: {
      body: 'Reminder: Your booking for *{{itemName}}* is tomorrow — {{when}}.',
    },
  },

  'booking.reminder_t1h': {
    sms: {
      body: 'Circls reminder: Your booking for {{itemName}} starts in an hour — {{when}}.',
    },
    whatsapp: {
      body: 'Starting in 1 hour: *{{itemName}}* — {{when}}.',
    },
  },

  'otp.login': {
    sms: {
      body: 'Your Circls login code is {{code}}. Valid for 10 minutes. Do not share.',
    },
  },

  // Questions threads (design doc 2026-07-18): org hears about new questions,
  // the asker hears about org/Circls replies. Email-only in v1.
  'question.asked': {
    email: {
      subject: 'New question on {{subjectName}}',
      body:
        'Hello,\n\n' +
        'A customer asked a new {{visibility}} question on {{subjectName}}:\n\n' +
        '"{{excerpt}}"\n\n' +
        'Reply from your Questions inbox:\n' +
        '{{portalUrl}}\n\n' +
        '— Circls\n',
    },
  },

  'question.replied': {
    email: {
      subject: 'New reply to your question — {{subjectName}}',
      body:
        'Hello,\n\n' +
        '{{authorName}} replied to your question on {{subjectName}}:\n\n' +
        '"{{excerpt}}"\n\n' +
        'View the conversation:\n' +
        '{{link}}\n\n' +
        '— Circls\n',
    },
  },

  'tenant.invitation': {
    email: {
      subject: "You've been invited to join {{tenantName}}",
      body:
        'Hello,\n\n' +
        '{{inviterName}} has invited you to join {{tenantName}} on Circls as {{role}}.\n\n' +
        'Accept the invitation and set up your account:\n' +
        '{{inviteUrl}}\n\n' +
        'This link expires on {{expiresAtIso}}. If you weren\'t expecting this email, you can safely ignore it.\n\n' +
        '— Circls\n',
    },
  },

  // Partner and admin emails with a design (partner.booking_confirmed,
  // listing.approved/rejected, admin.listing_submitted, admin.payouts_reminder,
  // admin.org_signup) live in ./email_designs.
  //
  // The daily summary has no design: plain text to the Circls admin team
  // (`admin.*` → the internal email sender).
  'admin.daily_digest': {
    email: {
      subject: '[Circls] Daily summary — {{dateLabel}}',
      body: '{{summary}}',
    },
  },
};

/** Replace `{{var}}` occurrences. Unresolved vars render as empty string. */
function substitute(template: string, payload: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_match, key: string) => {
    const v = payload[key];
    if (v === undefined || v === null) return '';
    return String(v);
  });
}

/**
 * Render a template for (channel, templateKey, payload).
 * Throws if the key is unknown or the channel isn't supported for that key —
 * the dispatcher marks the row failed in that case.
 */
export function renderTemplate(
  channel: NotificationChannel,
  templateKey: string,
  payload: Record<string, unknown> = {},
): RenderedTemplate {
  const def = TEMPLATES[templateKey];
  if (!def) {
    throw new Error(`unknown_template:${templateKey}`);
  }
  const channelTpl = def[channel];
  if (!channelTpl) {
    throw new Error(`channel_not_supported:${templateKey}:${channel}`);
  }
  const body = substitute(channelTpl.body, payload);
  if (channelTpl.subject !== undefined) {
    return { subject: substitute(channelTpl.subject, payload), body };
  }
  return { body };
}

/** Introspection helper — true iff a template+channel pair is renderable. */
export function templateSupportsChannel(
  channel: NotificationChannel,
  templateKey: string,
): boolean {
  const def = TEMPLATES[templateKey];
  return Boolean(def && def[channel]);
}
