// Pure presentation helpers for the consumer "trust" surfaces (org/brand blocks,
// venue About section, enriched membership page). Kept here (not in components)
// so they can be unit-tested under the node-only vitest setup.
import type { OrgSocials, OpeningHours } from '@/lib/api/types';

/** A structured address as exposed on PublicOrg / PublicVenue. */
export interface AddressLike {
  line1: string | null;
  line2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
}

/** Join a structured address into a single display line, skipping blanks.
 *  Returns null when nothing is set, so callers can omit the line entirely. */
export function formatAddress(address: AddressLike | null | undefined): string | null {
  if (!address) return null;
  const parts = [
    address.line1,
    address.line2,
    address.city,
    address.state,
    address.postalCode,
    address.country,
  ]
    .map((p) => (typeof p === 'string' ? p.trim() : ''))
    .filter((p) => p.length > 0);
  return parts.length ? parts.join(', ') : null;
}

export interface SocialLink {
  key: keyof OrgSocials;
  label: string;
  href: string;
}

const SOCIAL_LABELS: Record<keyof OrgSocials, string> = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  x: 'X',
  youtube: 'YouTube',
};

// Bare-handle → full-URL templates. A value already starting with http(s) is
// used as-is; otherwise we treat it as a handle and build the canonical URL.
const SOCIAL_URL: Record<keyof OrgSocials, (handle: string) => string> = {
  instagram: (h) => `https://instagram.com/${h}`,
  facebook: (h) => `https://facebook.com/${h}`,
  x: (h) => `https://x.com/${h}`,
  youtube: (h) => `https://youtube.com/@${h}`,
};

/** Order the socials block consistently for rendering. */
const SOCIAL_ORDER: (keyof OrgSocials)[] = ['instagram', 'facebook', 'x', 'youtube'];

/**
 * Shape an org's socials into an ordered list of {label, href}, skipping blanks.
 * Bare handles (with or without a leading '@') are normalized into full URLs;
 * values that are already absolute URLs are passed through untouched.
 */
export function socialLinks(socials: OrgSocials | null | undefined): SocialLink[] {
  if (!socials) return [];
  const out: SocialLink[] = [];
  for (const key of SOCIAL_ORDER) {
    const raw = socials[key];
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim().replace(/^@/, '');
    if (!trimmed) continue;
    const href = /^https?:\/\//i.test(trimmed) ? trimmed : SOCIAL_URL[key](trimmed);
    out.push({ key, label: SOCIAL_LABELS[key], href });
  }
  return out;
}

/**
 * The scope a membership applies to. When `venueId` is null the plan is
 * brand-wide (the org's name lives in the brand block, so we surface a generic
 * "Brand-wide" label rather than repeating it); otherwise it is the venue name.
 */
export function membershipScope(m: {
  venueId: string | null;
  scopeName: string;
}): { label: string; brandWide: boolean } {
  if (m.venueId === null) return { label: 'Brand-wide', brandWide: true };
  return { label: m.scopeName, brandWide: false };
}

// Opening-hours keys are "0"–"6" with 0 = Sunday (see OpeningHours docs).
// Displayed Monday-first, which reads more naturally for opening hours.
const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];
const DISPLAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

export interface OpeningHoursRow {
  day: string;
  /** Human label, e.g. "9:00–17:00, 18:00–22:00" or "Closed". */
  label: string;
  closed: boolean;
}

/**
 * Turn the structured opening hours into 7 ordered rows (Mon–Sun). A missing or
 * empty day is "Closed"; multiple intervals join with a comma. Returns null when
 * the whole object is absent so callers can omit the section.
 */
export function formatOpeningHours(oh: OpeningHours | null | undefined): OpeningHoursRow[] | null {
  if (!oh) return null;
  return DISPLAY_ORDER.map((idx) => {
    const intervals = oh[String(idx)] ?? [];
    const valid = Array.isArray(intervals)
      ? intervals.filter((i) => i && typeof i.open === 'string' && typeof i.close === 'string')
      : [];
    return {
      day: WEEKDAY_NAMES[idx],
      closed: valid.length === 0,
      label: valid.length === 0 ? 'Closed' : valid.map((i) => `${i.open}–${i.close}`).join(', '),
    };
  });
}
