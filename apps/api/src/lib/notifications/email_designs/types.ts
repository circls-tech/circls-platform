/**
 * A designed transactional email: one notification template key rendered as
 * branded HTML (plus a plain-text alternative).
 *
 * The same Handlebars source is used two ways:
 *   - rendered here, for the senders that take finished HTML (Resend, the
 *     sandbox's Mailpit), and
 *   - stored in MSG91 as its own template (`msg91Slug`), which MSG91 renders
 *     with the variables we send — so customer/partner email never carries
 *     our HTML over the wire, only the data.
 *
 * Variables are the notification payload plus the shared ones every design
 * gets at send time (see SHARED_VARIABLES in ./index.ts).
 */
export interface EmailDesign {
  /** The notification template key this design renders. */
  key: string;
  /** Template name shown in the MSG91 dashboard. */
  name: string;
  /**
   * MSG91 template slug (= the `template_id` sent with each email). Set for
   * every design MSG91 sends — customer and partner email. Unset for admin
   * designs: Resend sends those as rendered HTML; if they ever fall back to
   * MSG91 they go through the generic template as plain text.
   */
  msg91Slug?: string;
  /** Subject line (Handlebars, plain text). */
  subject: string;
  /** Full HTML document (Handlebars). */
  html: string;
  /** Plain-text alternative (Handlebars, not HTML-escaped). */
  text: string;
  /** Sample variables: the dev preview, tests and MSG91 test sends use them. */
  sample: Record<string, unknown>;
}
