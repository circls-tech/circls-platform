/**
 * Notification template engine. Phase 13 (Track B).
 *
 * Hardcoded English templates with simple `{{var}}` substitution. Each entry
 * is keyed by `templateKey` and has a per-channel rendering shape:
 *   - sms       → `{ body }`
 *   - email     → `{ subject, body }`
 *   - whatsapp  → `{ body }`
 *
 * Optional parts go in a section, `{{#var}}…{{/var}}`, which renders its
 * contents only when `var` is set (not missing, null or blank) — so a missing
 * value drops its whole clause instead of leaving "()" or an empty "Arena:"
 * line behind. Sections don't nest.
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

interface ChannelTemplates {
  sms?: ChannelTemplate;
  email?: ChannelTemplate;
  whatsapp?: ChannelTemplate;
}

interface TemplateDef extends ChannelTemplates {
  /**
   * Copy for one kind of booking, picked by the payload's `itemType` ('event',
   * 'membership'). It replaces the base copy channel by channel. The base is
   * the slot (court) copy, and it is also what a payload without `itemType`
   * renders, such as a reminder queued before variants existed.
   *
   * These are variants rather than new template keys because the key is also
   * the MSG91 flow id and the AiSensy campaign name (sms.ts, whatsapp.ts). A
   * new key would need provider-side setup before it could deliver anything.
   */
  variants?: Record<string, ChannelTemplates>;
}

/**
 * Static, hardcoded English templates. When we move to per-tenant copy this
 * becomes a DB-backed lookup; the call site doesn't change.
 *
 * Variable contract (what the dispatcher passes in `payload`; `?` = optional,
 * only ever used inside a section):
 *   booking.*          → itemType (picks the variant), bookingId, customerName,
 *                        venueName (the venue, else the organiser), when, and
 *                          slot       → arenaName?
 *                          event      → eventTitle
 *                          membership → membershipName?, validUntil?
 *   booking.confirmed  → the booking.* set + total? (amount with its currency,
 *                        e.g. "Rs 500.00" or "$25.00")
 *   booking.cancelled  → the booking.* set
 *   booking.reminder_* → the booking.* set (sent for slot bookings only)
 *   otp.login          → code
 *   tenant.invitation  → tenantName, inviterName, role, inviteUrl, expiresAtIso
 *   question.asked     → subjectName, excerpt, visibility, portalUrl
 *   question.replied   → subjectName, excerpt, authorName, link
 */
const TEMPLATES: Record<string, TemplateDef> = {
  'booking.confirmed': {
    sms: {
      body: 'Circls: Your booking at {{venueName}}{{#arenaName}} ({{arenaName}}){{/arenaName}} for {{when}} is confirmed. Ref {{bookingId}}.',
    },
    email: {
      subject: 'Booking confirmed — {{venueName}}',
      body:
        'Hi {{customerName}},\n\n' +
        'Your booking is confirmed.\n\n' +
        'Venue: {{venueName}}\n' +
        '{{#arenaName}}Arena: {{arenaName}}\n{{/arenaName}}' +
        'When: {{when}}\n' +
        '{{#total}}Total: {{total}}\n{{/total}}' +
        'Booking ref: {{bookingId}}\n\n' +
        'See you there!\n— Circls',
    },
    whatsapp: {
      body:
        'Booking confirmed at *{{venueName}}*{{#arenaName}} ({{arenaName}}){{/arenaName}} for {{when}}. ' +
        'Ref: {{bookingId}}.',
    },
    variants: {
      event: {
        sms: {
          body: 'Circls: Your booking for {{eventTitle}} at {{venueName}} on {{when}} is confirmed. Ref {{bookingId}}.',
        },
        email: {
          subject: 'Booking confirmed — {{eventTitle}}',
          body:
            'Hi {{customerName}},\n\n' +
            'Your booking for {{eventTitle}} is confirmed.\n\n' +
            'Event: {{eventTitle}}\n' +
            'Where: {{venueName}}\n' +
            'When: {{when}}\n' +
            '{{#total}}Total: {{total}}\n{{/total}}' +
            'Booking ref: {{bookingId}}\n\n' +
            'See you there!\n— Circls',
        },
        whatsapp: {
          body:
            'Booking confirmed for *{{eventTitle}}* at {{venueName}} on {{when}}. ' +
            'Ref: {{bookingId}}.',
        },
      },
      membership: {
        sms: {
          body:
            'Circls: Your membership{{#membershipName}} {{membershipName}}{{/membershipName}} at {{venueName}} ' +
            'is confirmed{{#validUntil}}, valid until {{validUntil}}{{/validUntil}}. Ref {{bookingId}}.',
        },
        email: {
          subject: 'Membership confirmed — {{venueName}}',
          body:
            'Hi {{customerName}},\n\n' +
            'Your membership is confirmed.\n\n' +
            '{{#membershipName}}Membership: {{membershipName}}\n{{/membershipName}}' +
            'Where: {{venueName}}\n' +
            '{{#validUntil}}Valid until: {{validUntil}}\n{{/validUntil}}' +
            '{{#total}}Total: {{total}}\n{{/total}}' +
            'Booking ref: {{bookingId}}\n\n' +
            'See you there!\n— Circls',
        },
        whatsapp: {
          body:
            'Membership confirmed{{#membershipName}}: *{{membershipName}}*{{/membershipName}} at {{venueName}}' +
            '{{#validUntil}}, valid until {{validUntil}}{{/validUntil}}. Ref: {{bookingId}}.',
        },
      },
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
    variants: {
      event: {
        sms: {
          body: 'Circls: Your booking for {{eventTitle}} at {{venueName}} on {{when}} has been cancelled. Ref {{bookingId}}.',
        },
        email: {
          subject: 'Booking cancelled — {{eventTitle}}',
          body:
            'Hi {{customerName}},\n\n' +
            'Your booking for {{eventTitle}} at {{venueName}} on {{when}} has been cancelled.\n\n' +
            'Booking ref: {{bookingId}}\n\n' +
            '— Circls',
        },
      },
      membership: {
        sms: {
          body:
            'Circls: Your membership{{#membershipName}} {{membershipName}}{{/membershipName}} at {{venueName}} ' +
            'has been cancelled. Ref {{bookingId}}.',
        },
        email: {
          subject: 'Membership cancelled — {{venueName}}',
          body:
            'Hi {{customerName}},\n\n' +
            'Your membership{{#membershipName}} {{membershipName}}{{/membershipName}} at {{venueName}} ' +
            'has been cancelled.\n\n' +
            'Booking ref: {{bookingId}}\n\n' +
            '— Circls',
        },
      },
    },
  },

  'booking.reminder_t24h': {
    sms: {
      body: 'Circls reminder: You have a booking tomorrow at {{venueName}}{{#arenaName}} ({{arenaName}}){{/arenaName}} — {{when}}.',
    },
    whatsapp: {
      body: 'Reminder: Your booking at *{{venueName}}*{{#arenaName}} ({{arenaName}}){{/arenaName}} is tomorrow — {{when}}.',
    },
  },

  'booking.reminder_t1h': {
    sms: {
      body: 'Circls reminder: Your booking at {{venueName}}{{#arenaName}} ({{arenaName}}){{/arenaName}} starts in an hour — {{when}}.',
    },
    whatsapp: {
      body: 'Starting in 1 hour: *{{venueName}}*{{#arenaName}} ({{arenaName}}){{/arenaName}} — {{when}}.',
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

const SECTION_RE = /\{\{#\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}([\s\S]*?)\{\{\/\s*\1\s*\}\}/g;
const VAR_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

/** A value a section shows for: present and not blank. */
function isSet(v: unknown): boolean {
  return v !== undefined && v !== null && String(v).trim() !== '';
}

/**
 * Resolve `{{#var}}…{{/var}}` sections, then replace `{{var}}` occurrences.
 * Unresolved vars render as empty string.
 */
function substitute(template: string, payload: Record<string, unknown>): string {
  return template
    .replace(SECTION_RE, (_match, key: string, inner: string) => (isSet(payload[key]) ? inner : ''))
    .replace(VAR_RE, (_match, key: string) => {
      const v = payload[key];
      if (v === undefined || v === null) return '';
      return String(v);
    });
}

/** The variant a payload asks for, if the template has one. */
function variantFor(def: TemplateDef, payload: Record<string, unknown>): ChannelTemplates | undefined {
  const itemType = payload['itemType'];
  if (typeof itemType !== 'string' || !def.variants || !Object.hasOwn(def.variants, itemType)) {
    return undefined;
  }
  return def.variants[itemType];
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
  const channelTpl = variantFor(def, payload)?.[channel] ?? def[channel];
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

/**
 * Test-only: the `[templateKey, variant]` pairs that exist, with the channels
 * each defines. The template tests use it to keep every variant's channels in
 * step with its base copy.
 */
export function __templateChannelsForTesting(): {
  templateKey: string;
  variant: string | null;
  channels: NotificationChannel[];
}[] {
  const channelsOf = (t: ChannelTemplates): NotificationChannel[] =>
    (['sms', 'email', 'whatsapp'] as const).filter((c) => t[c] !== undefined);
  return Object.entries(TEMPLATES).flatMap(([templateKey, def]) => [
    { templateKey, variant: null, channels: channelsOf(def) },
    ...Object.entries(def.variants ?? {}).map(([variant, t]) => ({
      templateKey,
      variant,
      channels: channelsOf(t),
    })),
  ]);
}
