/**
 * Partner-authored "what to do next" link, stored as a `post_booking_redirect`
 * JSONB column on events (null = nothing to show). Surfaced to the customer
 * once their booking is confirmed — typically a Google Form to collect squad
 * details, a WhatsApp community invite, or a waiver to sign.
 *
 * Lives in its own module (no table imports) so the schema, the request
 * validator in `lib/post_booking_redirect_schema.ts`, and the services can all
 * import the type without cycles — same arrangement as `qr_ticket_config.ts`.
 *
 * The URL is validated to be http(s) at write time; the consumer clients still
 * re-check the scheme before navigating (defence in depth — rows predate any
 * given client build).
 */
export interface PostBookingRedirect {
  /** Absolute http(s) destination. */
  url: string;
  /** Partner's own copy explaining why the customer should follow the link;
   *  null = the client falls back to generic wording. */
  description: string | null;
  /**
   * true  = the confirmation screen counts down and opens the link in a new
   *         tab (with a visible skip), for steps the partner treats as
   *         mandatory. The customer keeps the confirmation page either way.
   * false = the link is offered as a button the customer may ignore.
   */
  forced: boolean;
}
