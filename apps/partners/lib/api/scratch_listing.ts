/**
 * Scratch listings: what a create form posts to the consumer site's scratch
 * preview page (apps/consumer/lib/preview.ts, SCRATCH_ID) so the partner can
 * see the customer page before anything is saved. The shapes mirror the
 * consumer site's public listing types — the page renders them exactly as it
 * renders a fetched listing — so a field added there is added here too.
 */
import { tiersToPayload, type TierDraft } from '@/components/TiersEditor';
import {
  membershipTiersToPayload,
  type MembershipTierDraft,
} from '@/components/MembershipTiersEditor';
import type { TenantProfile, Venue } from './types';

/** The id every scratch listing carries; the consumer page keys on it. */
export const SCRATCH_ID = 'scratch';
/** postMessage protocol with the framed consumer page. */
export const SCRATCH_READY_MESSAGE = 'circls:scratch-ready';
export const SCRATCH_LISTING_MESSAGE = 'circls:scratch-listing';

export interface ScratchBrand {
  id: string;
  slug: string;
  name: string;
  logoUrl: string | null;
}

export interface ScratchEventTier {
  id: string;
  name: string;
  description: string | null;
  pricePaise: number;
  capacity: number | null;
  remaining: number | null;
}

export interface ScratchOccurrence {
  id: string;
  startsAt: string;
  endsAt: string;
  locationName: string;
}

/** Mirrors the consumer's PublicEventWithVenue (detail view). */
export interface ScratchEvent {
  id: string;
  tenantId: string;
  venueId: string | null;
  venueName: string | null;
  venueTags: string[];
  isStandalone: boolean;
  name: string;
  description: string | null;
  /** '' until the form has a start; the page says so. */
  startsAt: string;
  endsAt: string;
  pricePaise: number;
  capacity: number | null;
  maxPerUser: number | null;
  status: 'published';
  brand: ScratchBrand;
  tiers: ScratchEventTier[];
  questions: never[];
  locationName: string;
  locLat: number | null;
  locLng: number | null;
  locTzName: string;
  locAddressJson: Record<string, unknown> | null;
  /** Photos travel separately as Files; the page builds the gallery. */
  images: never[];
  seriesOccurrences?: ScratchOccurrence[];
}

export interface ScratchAddress {
  line1: string;
  line2: string;
  city: string;
  state: string;
  pincode: string;
  country: string;
}

export function brandOf(tenantId: string, profile: TenantProfile | undefined): ScratchBrand {
  return {
    id: tenantId,
    slug: profile?.slug ?? '',
    name: profile?.name ?? 'Your organisation',
    logoUrl: profile?.logoUrl ?? null,
  };
}

function eventTiers(tiers: TierDraft[]): ScratchEventTier[] {
  return tiersToPayload(tiers)
    .filter((t) => t.name)
    .map((t, i) => ({
      id: `${SCRATCH_ID}-${i}`,
      name: t.name,
      description: t.description ?? null,
      pricePaise: Number.isFinite(t.pricePaise) ? t.pricePaise : 0,
      capacity: t.capacity,
      remaining: t.capacity,
    }));
}

function venueAddress(v: Venue): Record<string, unknown> {
  return {
    line1: v.addressLine1 ?? undefined,
    line2: v.addressLine2 ?? undefined,
    city: v.city ?? undefined,
    state: v.state ?? undefined,
    pincode: v.postalCode ?? undefined,
    country: v.country ?? undefined,
  };
}

export function scratchEvent(input: {
  tenantId: string;
  brand: ScratchBrand;
  name: string;
  description: string;
  startsAt: string;
  endsAt: string;
  tiers: TierDraft[];
  maxPerUser: number | null;
  /** The venue the event is at, or null with `address` for a standalone one. */
  venue: Venue | null | undefined;
  address?: ScratchAddress;
  tz: string;
  occurrences?: ScratchOccurrence[];
}): ScratchEvent {
  const tiers = eventTiers(input.tiers);
  const v = input.venue ?? null;
  const addr = input.address;
  const city = addr?.city.trim();
  return {
    id: SCRATCH_ID,
    tenantId: input.tenantId,
    venueId: v?.id ?? null,
    venueName: v?.name ?? null,
    venueTags: v?.tags ?? [],
    isStandalone: !v,
    name: input.name.trim() || 'Untitled event',
    description: input.description.trim() || null,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    pricePaise: tiers.length ? Math.min(...tiers.map((t) => t.pricePaise)) : 0,
    capacity: null,
    maxPerUser: input.maxPerUser,
    status: 'published',
    brand: input.brand,
    tiers,
    questions: [],
    locationName: v?.name ?? (city ? city : input.brand.name),
    locLat: v?.lat ?? null,
    locLng: v?.lng ?? null,
    locTzName: input.tz,
    locAddressJson: v ? venueAddress(v) : addr ? { ...addr } : null,
    images: [],
    ...(input.occurrences && input.occurrences.length > 1
      ? { seriesOccurrences: input.occurrences }
      : {}),
  };
}

export interface ScratchBenefits {
  items: { label: string; detail?: string }[];
}

export interface ScratchMembershipTier {
  id: string;
  name: string;
  description: string | null;
  pricePaise: number;
  durationDays: number;
  benefits: ScratchBenefits;
  capacity: number | null;
  remaining: number | null;
}

/** Mirrors the consumer's PublicMembershipWithScope. */
export interface ScratchMembership {
  id: string;
  tenantId: string;
  venueId: string | null;
  name: string;
  description: string | null;
  pricePaise: number;
  durationDays: number;
  benefits: ScratchBenefits;
  terms: string | null;
  /** Artwork travels separately as a File. */
  artworkUrl: null;
  brand: ScratchBrand;
  status: 'active';
  tiers: ScratchMembershipTier[];
  scopeName: string;
  venueTags: string[];
  city: string | null;
  lat: number | null;
  lng: number | null;
  country: string | null;
}

export function scratchMembership(input: {
  tenantId: string;
  brand: ScratchBrand;
  name: string;
  description: string;
  terms: string;
  tiers: MembershipTierDraft[];
  venue: Venue | null | undefined;
  tenantCountry: string | null;
}): ScratchMembership {
  const tiers: ScratchMembershipTier[] = membershipTiersToPayload(input.tiers)
    .filter((t) => t.name)
    .map((t, i) => ({
      id: `${SCRATCH_ID}-${i}`,
      name: t.name,
      description: t.description ?? null,
      pricePaise: Number.isFinite(t.pricePaise) ? t.pricePaise : 0,
      durationDays: Number.isFinite(t.durationDays) ? t.durationDays : 30,
      benefits: t.benefits ?? { items: [] },
      capacity: t.capacity,
      remaining: t.capacity,
    }));
  const cheapest = tiers.length
    ? tiers.reduce((a, b) => (b.pricePaise < a.pricePaise ? b : a))
    : null;
  const v = input.venue ?? null;
  return {
    id: SCRATCH_ID,
    tenantId: input.tenantId,
    venueId: v?.id ?? null,
    name: input.name.trim() || 'Untitled plan',
    description: input.description.trim() || null,
    pricePaise: cheapest?.pricePaise ?? 0,
    durationDays: cheapest?.durationDays ?? 30,
    benefits: cheapest?.benefits ?? { items: [] },
    terms: input.terms.trim() || null,
    artworkUrl: null,
    brand: input.brand,
    status: 'active',
    tiers,
    scopeName: v?.name ?? input.brand.name,
    venueTags: v?.tags ?? [],
    city: v?.city ?? null,
    lat: v?.lat ?? null,
    lng: v?.lng ?? null,
    country: v?.country ?? input.tenantCountry,
  };
}
