/**
 * Listing previews: let a partner, or the Circls reviewer about to approve
 * their listing, open it on the consumer site exactly as a customer would see
 * it — before it is approved, while it is still a draft or pending review.
 *
 * The consumer app's own detail pages do the rendering (one source of truth
 * for "what customers see"); this module only decides who may look. A preview
 * is a short-lived HMAC-signed token naming ONE listing. The consumer page is
 * opened with it as `?preview=<token>` and sends it to the API in the
 * `X-Circls-Preview` header (PREVIEW_HEADER) — a header, not a query string,
 * so the token never lands in the API's request logs. When it names the
 * listing being fetched, that read skips the approval / tenant-active
 * visibility gate. Nothing else changes: booking stays refused server-side (a
 * draft event is not `published`), and the token opens no other listing.
 *
 * Tokens are stateless so there is nothing to store or sweep; they expire
 * on their own, and the portals mint a fresh one each time a preview opens.
 */
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { arenas, events, memberships, venues } from '../db/schema/index.js';
import { env } from '../config/env.js';

/** The listings that have a consumer detail page of their own. An arena is
 *  previewed through its venue's page, where customers find it. */
export const PREVIEW_TYPES = ['venue', 'event', 'membership'] as const;
export type PreviewType = (typeof PREVIEW_TYPES)[number];

/** How long a minted preview link stays valid. Long enough to read a listing
 *  through and share the link across the desk; short enough that a leaked
 *  link is not a lasting back door to an unapproved listing. */
export const PREVIEW_TTL_SEC = 60 * 60;

/** The request header the consumer site sends a preview token in. Redacted
 *  from request logs in server.ts. */
export const PREVIEW_HEADER = 'x-circls-preview';

const TOKEN_VERSION = 1;

/** Resolved once per process. Production requires the configured secret
 *  (env.ts refuses to boot without it); dev and test fall back to a random
 *  one, so previews there work only against this instance until it restarts. */
const SECRET: string = env.LISTING_PREVIEW_SECRET ?? crypto.randomBytes(32).toString('hex');

export interface PreviewClaims {
  type: PreviewType;
  id: string;
  /** Unix seconds. */
  exp: number;
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64url');
}

function sign(payload: string): string {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}

/** Mint a token naming one listing, valid for `ttlSec` from now. */
export function mintPreviewToken(
  target: { type: PreviewType; id: string },
  opts: { ttlSec?: number; now?: Date } = {},
): { token: string; expiresAt: Date } {
  const nowMs = (opts.now ?? new Date()).getTime();
  const exp = Math.floor(nowMs / 1000) + (opts.ttlSec ?? PREVIEW_TTL_SEC);
  const claims: PreviewClaims & { v: number } = { v: TOKEN_VERSION, type: target.type, id: target.id, exp };
  const payload = b64url(JSON.stringify(claims));
  return { token: `${payload}.${sign(payload)}`, expiresAt: new Date(exp * 1000) };
}

/**
 * Verify a token and return its claims, or null for anything that is not a
 * currently valid token minted here: malformed, tampered, expired, or a
 * version this build does not issue.
 */
export function verifyPreviewToken(token: string, now: Date = new Date()): PreviewClaims | null {
  if (typeof token !== 'string' || token.length === 0 || token.length > 1024) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof claims !== 'object' || claims === null) return null;
  const c = claims as Record<string, unknown>;
  if (c['v'] !== TOKEN_VERSION) return null;
  if (typeof c['type'] !== 'string' || !(PREVIEW_TYPES as readonly string[]).includes(c['type'])) return null;
  if (typeof c['id'] !== 'string' || c['id'].length === 0) return null;
  if (typeof c['exp'] !== 'number' || !Number.isFinite(c['exp'])) return null;
  if (c['exp'] * 1000 <= now.getTime()) return null;
  return { type: c['type'] as PreviewType, id: c['id'], exp: c['exp'] };
}

/**
 * Whether `token` (the PREVIEW_HEADER value, possibly absent) is a valid
 * preview of exactly this listing. The consumer routes call this per read:
 * a token for one listing never unlocks another.
 */
export function previewAllows(
  token: unknown,
  target: { type: PreviewType; id: string },
): boolean {
  if (typeof token !== 'string' || token === '') return false;
  const claims = verifyPreviewToken(token);
  return claims !== null && claims.type === target.type && claims.id === target.id;
}

/** The consumer-site path a customer would open for this listing. */
export function previewPath(type: PreviewType, id: string): string {
  switch (type) {
    case 'venue':
      return `/venues/${id}`;
    case 'event':
      return `/events/${id}`;
    case 'membership':
      return `/memberships/${id}`;
  }
}

export interface ListingPreview {
  /** The consumer-site URL carrying the token: open it, or frame it. */
  url: string;
  type: PreviewType;
  id: string;
  expiresAt: string;
}

/** Mint a preview and build the consumer-site URL that carries it. */
export function createListingPreview(target: { type: PreviewType; id: string }): ListingPreview {
  const { token, expiresAt } = mintPreviewToken(target);
  const url = new URL(previewPath(target.type, target.id), env.CONSUMER_BASE_URL);
  url.searchParams.set('preview', token);
  return { url: url.toString(), type: target.type, id: target.id, expiresAt: expiresAt.toISOString() };
}

/**
 * Resolve the listing a caller wants to preview into the page that shows it
 * and the tenant that owns it, or null when it does not exist. Arenas resolve
 * to their venue's page — that is where a customer meets them.
 */
export async function resolvePreviewTarget(
  type: PreviewType | 'arena',
  id: string,
): Promise<{ type: PreviewType; id: string; tenantId: string } | null> {
  if (type === 'arena') {
    const [r] = await db
      .select({ venueId: arenas.venueId, tenantId: venues.tenantId })
      .from(arenas)
      .innerJoin(venues, eq(venues.id, arenas.venueId))
      .where(eq(arenas.id, id))
      .limit(1);
    return r ? { type: 'venue', id: r.venueId, tenantId: r.tenantId } : null;
  }
  const table = type === 'venue' ? venues : type === 'event' ? events : memberships;
  const [r] = await db
    .select({ tenantId: table.tenantId })
    .from(table)
    .where(eq(table.id, id))
    .limit(1);
  return r ? { type, id, tenantId: r.tenantId } : null;
}
