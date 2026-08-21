import { z } from 'zod';
import type { PostBookingRedirect } from '../db/schema/post_booking_redirect.js';

/** Longest partner blurb we render on the confirmation screen. */
export const MAX_REDIRECT_DESCRIPTION = 500;

/**
 * Schemes a post-booking link may use. Deliberately just http(s): the stored
 * URL ends up in an `href`/`location.href` on the consumer app, so anything
 * script-bearing (`javascript:`), inline (`data:`), or app-local (`file:`) is
 * refused at the door rather than filtered downstream.
 */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/** true when `raw` parses as an absolute http(s) URL. */
export function isAllowedRedirectUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  return ALLOWED_PROTOCOLS.has(parsed.protocol);
}

/**
 * Shared request-body validator for the `postBookingRedirect` field on the
 * event create + update payloads. `null` clears the redirect (nothing shown
 * after booking); omitting the field leaves it unchanged (routes only patch
 * when the key is present).
 */
export const postBookingRedirectSchema = z
  .object({
    url: z
      .string()
      .trim()
      .min(1)
      // Generous but bounded — long-tail form URLs carry prefilled query
      // params, while a megabyte of "URL" never reaches the column.
      .max(2000)
      .refine(isAllowedRedirectUrl, { message: 'Enter a full http:// or https:// link' }),
    description: z
      .string()
      .trim()
      .max(MAX_REDIRECT_DESCRIPTION)
      .nullable()
      .optional()
      .default(null),
    forced: z.boolean().optional().default(false),
  })
  .nullable();

/** Normalise a parsed payload value to the stored shape (blank blurb ⇒ null). */
export function toPostBookingRedirect(
  value: z.infer<typeof postBookingRedirectSchema>,
): PostBookingRedirect | null {
  if (!value) return null;
  return {
    url: value.url,
    description: value.description?.trim() ? value.description.trim() : null,
    forced: value.forced,
  };
}
