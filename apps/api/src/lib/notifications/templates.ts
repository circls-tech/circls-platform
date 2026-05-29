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
 *   booking.confirmed  → venueName, arenaName, when, totalRupees, bookingId
 *   booking.cancelled  → venueName, when, refundRupees? (omit when free)
 *   booking.reminder_* → venueName, arenaName, when
 *   kyc.verified       → tenantName
 *   kyc.rejected       → tenantName, reason
 *   otp.login          → code
 *   tenant.invitation  → tenantName, inviterName, role, inviteUrl, expiresAtIso
 */
const TEMPLATES: Record<string, TemplateDef> = {
  'booking.confirmed': {
    sms: {
      body: 'Circls: Your booking at {{venueName}} ({{arenaName}}) for {{when}} is confirmed. Ref {{bookingId}}.',
    },
    email: {
      subject: 'Booking confirmed — {{venueName}}',
      body:
        'Hi {{customerName}},\n\n' +
        'Your booking is confirmed.\n\n' +
        'Venue: {{venueName}}\n' +
        'Arena: {{arenaName}}\n' +
        'When: {{when}}\n' +
        'Total: Rs {{totalRupees}}\n' +
        'Booking ref: {{bookingId}}\n\n' +
        'See you there!\n— Circls',
    },
    whatsapp: {
      body:
        'Booking confirmed at *{{venueName}}* ({{arenaName}}) for {{when}}. ' +
        'Ref: {{bookingId}}.',
    },
  },

  'booking.cancelled': {
    sms: {
      body: 'Circls: Your booking at {{venueName}} on {{when}} has been cancelled. Ref {{bookingId}}.',
    },
    email: {
      subject: 'Booking cancelled — {{venueName}}',
      body:
        'Hi {{customerName}},\n\n' +
        'Your booking at {{venueName}} on {{when}} has been cancelled.\n\n' +
        'Booking ref: {{bookingId}}\n\n' +
        '— Circls',
    },
  },

  'booking.reminder_t24h': {
    sms: {
      body: 'Circls reminder: You have a booking tomorrow at {{venueName}} ({{arenaName}}) — {{when}}.',
    },
    whatsapp: {
      body: 'Reminder: Your booking at *{{venueName}}* ({{arenaName}}) is tomorrow — {{when}}.',
    },
  },

  'booking.reminder_t1h': {
    sms: {
      body: 'Circls reminder: Your booking at {{venueName}} ({{arenaName}}) starts in an hour — {{when}}.',
    },
    whatsapp: {
      body: 'Starting in 1 hour: *{{venueName}}* ({{arenaName}}) — {{when}}.',
    },
  },

  'kyc.verified': {
    email: {
      subject: 'KYC verified — welcome to Circls',
      body:
        'Hi,\n\n' +
        'Your organisation {{tenantName}} is now KYC-verified. ' +
        'You can start accepting bookings and payouts.\n\n' +
        '— Circls',
    },
  },

  'kyc.rejected': {
    email: {
      subject: 'KYC needs attention — {{tenantName}}',
      body:
        'Hi,\n\n' +
        'Your KYC submission for {{tenantName}} could not be verified.\n\n' +
        'Reason: {{reason}}\n\n' +
        'Please update your documents from the Partner portal and resubmit.\n\n' +
        '— Circls',
    },
  },

  'otp.login': {
    sms: {
      body: 'Your Circls login code is {{code}}. Valid for 10 minutes. Do not share.',
    },
  },

  'tenant.invitation': {
    email: {
      subject: "You've been invited to {{tenantName}} on Circls",
      body:
        'Hello,\n\n' +
        '{{inviterName}} has invited you to join {{tenantName}} on Circls as {{role}}.\n\n' +
        'Accept the invitation and set up your account:\n' +
        '{{inviteUrl}}\n\n' +
        'This link expires on {{expiresAtIso}}. If you weren\'t expecting this email, you can safely ignore it.\n\n' +
        '— Circls\n',
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
