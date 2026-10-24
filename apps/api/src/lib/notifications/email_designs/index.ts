/**
 * Designed-email registry and renderer.
 *
 * `renderEmail(key, payload)` is the one entry point every email sender uses:
 * a key with a design renders its branded HTML + text + subject; any other key
 * renders its plain-text template from ../templates.ts (no HTML).
 *
 * `emailVariables(payload)` is what a design actually sees — the payload plus
 * the shared, environment-dependent values below. MSG91 gets exactly this
 * object as its template variables, so a design renders the same here and
 * there.
 */
import Handlebars from 'handlebars';
import { env } from '../../../config/env.js';
import { renderTemplate } from '../templates.js';
import { stripZeroWidth } from '../email_format.js';
import { adminListingSubmitted, adminOrgSignup, adminPayoutsReminder } from './admin.js';
import { bookingCancelled, bookingConfirmed, bookingRefunded } from './consumer.js';
import { listingApproved, listingRejected, partnerBookingConfirmed } from './partner.js';
import type { EmailDesign } from './types.js';

export type { EmailDesign } from './types.js';

export const EMAIL_DESIGNS: readonly EmailDesign[] = [
  bookingConfirmed,
  bookingCancelled,
  bookingRefunded,
  partnerBookingConfirmed,
  listingApproved,
  listingRejected,
  adminListingSubmitted,
  adminPayoutsReminder,
  adminOrgSignup,
];

const BY_KEY = new Map(EMAIL_DESIGNS.map((d) => [d.key, d]));

export function getEmailDesign(templateKey: string): EmailDesign | undefined {
  return BY_KEY.get(templateKey);
}

const trimSlash = (u: string): string => u.replace(/\/+$/, '');

/**
 * Values every design may use, filled in at send time rather than stored on
 * the notification row: the portal base URLs (they differ per environment)
 * and whether replies reach a person (EMAIL_REPLY_TO).
 */
export function sharedEmailVariables(): Record<string, unknown> {
  return {
    consumerUrl: trimSlash(env.CONSUMER_BASE_URL),
    partnersUrl: trimSlash(env.PARTNERS_BASE_URL),
    adminUrl: trimSlash(env.ADMIN_BASE_URL),
    canReply: Boolean(env.EMAIL_REPLY_TO),
  };
}

/** The variables a design renders with — shared values, then the payload. */
export function emailVariables(payload: Record<string, unknown>): Record<string, unknown> {
  return { ...sharedEmailVariables(), ...payload };
}

// One isolated Handlebars instance: no helpers or partials registered, the
// same feature set MSG91 renders with.
const hbs = Handlebars.create();
const compiled = new Map<string, Handlebars.TemplateDelegate>();

function compile(id: string, source: string, escape: boolean): Handlebars.TemplateDelegate {
  const cacheKey = `${id}:${escape ? 'html' : 'text'}`;
  let t = compiled.get(cacheKey);
  if (!t) {
    // Plain text keeps every newline as written: by default Handlebars drops
    // the line break after a block tag alone on its line, which would glue a
    // text email's sections together.
    t = hbs.compile(source, { noEscape: !escape, strict: false, ignoreStandalone: !escape });
    compiled.set(cacheKey, t);
  }
  return t;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  /** Present only for designed emails. */
  html?: string;
}

/** Render one design with the given (already merged) variables. */
export function renderDesign(design: EmailDesign, variables: Record<string, unknown>): Required<RenderedEmail> {
  return {
    subject: compile(`${design.key}#subject`, design.subject, false)(variables).trim(),
    html: compile(`${design.key}#html`, design.html, true)(variables),
    // noAutoLink's zero-width characters are for the HTML only.
    text: compile(`${design.key}#text`, design.text, false)(stripZeroWidth(variables)),
  };
}

/**
 * Render an email for any template key. Throws on an unknown key (the
 * dispatcher marks the notification row failed), like renderTemplate.
 */
export function renderEmail(templateKey: string, payload: Record<string, unknown> = {}): RenderedEmail {
  const design = getEmailDesign(templateKey);
  if (design) return renderDesign(design, emailVariables(payload));
  const plain = renderTemplate('email', templateKey, payload);
  return { subject: plain.subject ?? '(no subject)', text: plain.body };
}

/** True iff `templateKey` can be sent by email (designed or plain). */
export function emailTemplateExists(templateKey: string): boolean {
  if (getEmailDesign(templateKey)) return true;
  try {
    renderTemplate('email', templateKey, {});
    return true;
  } catch {
    return false;
  }
}

/**
 * The slug MSG91 gives a template created through its API: it ignores the
 * slug sent and derives one from the name ("Circls · Booking confirmed" →
 * "circls_booking_confirmed"). Each design's `msg91Slug` must equal this for
 * its `name` (a test keeps them in step).
 */
export function msg91SlugFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * MSG91 template id for an email, when it has its own switched-on template:
 * the MSG91_EMAIL_TEMPLATES mapping for the key, else the design's slug if
 * MSG91_EMAIL_DESIGNS lists the key (or "all"). Undefined ⇒ send through the
 * generic template — every email until its own template is approved and
 * switched on.
 */
export function msg91TemplateId(templateKey: string): string | undefined {
  const override = env.MSG91_EMAIL_TEMPLATES?.[templateKey];
  if (override) return override;
  const slug = getEmailDesign(templateKey)?.msg91Slug;
  if (!slug) return undefined;
  const on = env.MSG91_EMAIL_DESIGNS ?? [];
  return on.includes('all') || on.includes(templateKey) ? slug : undefined;
}
