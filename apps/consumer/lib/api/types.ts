// Local mirror of the consumer API response shapes (apps/api/src/routes/consumer.ts).
// Mirrors the partner portal's convention of keeping a local types file rather
// than sharing a package across apps.

/** An uploaded photo reference (public R2 URL), ordered by position (0 = cover). */
export interface ImageRef {
  url: string;
  position: number;
}

/** Social handles/URLs an org advertises (PR #108). */
export interface OrgSocials {
  instagram?: string;
  facebook?: string;
  x?: string;
  youtube?: string;
}

/**
 * Compact owning-org summary (PR #108) attached to public venue/event/
 * membership payloads so a card can show "by {org}" without a second request.
 */
export interface Brand {
  id: string;
  slug: string;
  name: string;
  logoUrl: string | null;
}

/** Per-weekday opening hours (PR #109): keys "0"–"6" (0 = Sunday); empty/missing
 *  array = closed; times are venue-local "HH:MM". */
export type OpeningHours = Record<string, { open: string; close: string }[]>;

/**
 * Full public org/brand profile (PR #108), from GET /v1/consumer/orgs/:slug.
 * Never includes billing/internal fields.
 */
export interface PublicOrg {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  logoUrl: string | null;
  websiteUrl: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  socials: OrgSocials | null;
  address: {
    line1: string | null;
    line2: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
    country: string | null;
  };
}

export interface PublicVenue {
  id: string;
  name: string;
  tags: string[];
  lat: number | null;
  lng: number | null;
  addressJson: Record<string, unknown> | null;
  /** Trust metadata (PR #109). */
  description: string | null;
  amenities: string[];
  openingHours: OpeningHours | null;
  contactPhone: string | null;
  contactEmail: string | null;
  address: {
    line1: string | null;
    line2: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
    country: string | null;
  };
  /** Owning-org summary (PR #108). */
  brand: Brand;
  /** Uploaded venue photos, ordered by position; [] when none (card falls back). */
  images: ImageRef[];
}

export interface PublicArena {
  id: string;
  name: string;
  sport: string | null;
  capacity: number | null;
  slotDurationMin: number;
  tags: string[];
}

export interface VenueDetail {
  venue: PublicVenue;
  arenas: PublicArena[];
}

export interface PublicSlot {
  id: string;
  arenaId: string;
  /** ISO-8601 lower bound of the slot. */
  startAt: string;
  /** ISO-8601 upper bound of the slot. */
  endAt: string;
  pricePaise: number;
  status: 'open';
}

/** A ticket tier for an event. `remaining` is `capacity - sold`, or null when
 *  the tier is uncapped. */
export interface PublicTier {
  id: string;
  name: string;
  description: string | null;
  pricePaise: number;
  capacity: number | null;
  remaining: number | null;
}

export interface PublicEvent {
  id: string;
  tenantId: string;
  venueId: string;
  name: string;
  description: string | null;
  /** ISO-8601 */
  startsAt: string;
  /** ISO-8601 */
  endsAt: string;
  pricePaise: number;
  capacity: number | null;
  status: 'published';
  /** Owning-org summary (PR #108). */
  brand: Brand;
  /** Ticket tiers; [] on list/upcoming responses, populated on the detail view. */
  tiers: PublicTier[];
}

/** A single membership perk (PR #110). */
export interface MembershipBenefitItem {
  label: string;
  detail?: string;
}
/** Typed membership benefits (PR #110). */
export interface MembershipBenefits {
  items: MembershipBenefitItem[];
}

export interface PublicMembership {
  id: string;
  tenantId: string;
  venueId: string | null;
  name: string;
  description: string | null;
  pricePaise: number;
  durationDays: number;
  /** Typed benefits (PR #110) — always { items: [...] }. */
  benefits: MembershipBenefits;
  /** Plan terms & conditions (PR #110). */
  terms: string | null;
  /** Public artwork URL (PR #110), or null. */
  artworkUrl: string | null;
  /** Owning-org summary (PR #108). */
  brand: Brand;
  status: 'active';
}

// ── Booking / purchase results ────────────────────────────────────────────────

export interface SlotBookingResult {
  bookingId: string;
  payment: {
    orderId: string;
    /** Empty string in stub mode (no live Razorpay keys configured). */
    keyId: string;
    amountPaise: number;
    currency: 'INR';
  };
}

export interface BookingRow {
  id: string;
  status: string;
  [key: string]: unknown;
}

export interface EventBookingResult {
  booking: BookingRow;
  paymentId?: string;
  /** Present only for paid events; free events return a confirmed booking and no order. */
  providerOrderId?: string;
  /** Razorpay publishable key + amount for opening checkout (paid only). */
  keyId?: string;
  amountPaise?: number;
}

export interface MembershipPurchaseResult {
  userMembershipId: string;
  paymentId?: string;
  /** Present only for paid memberships; free ones activate immediately. */
  orderId?: string;
  /** Razorpay publishable key + amount for opening checkout (paid only). */
  keyId?: string;
  amountPaise?: number;
}

// ── Booking / purchase inputs ─────────────────────────────────────────────────

export interface PurchaseMembershipInput {
  membershipId: string;
  couponCode?: string;
}

export interface MyBooking {
  id: string;
  venueId: string | null;
  venueName: string;
  itemType: string;
  status: string;
  totalPaise: number;
  /** ISO-8601 */
  createdAt: string;
}

/** One booked slot within a court (slot) booking. */
export interface MyBookingSlot {
  id: string;
  /** ISO-8601 */
  startAt: string;
  /** ISO-8601 */
  endAt: string;
  pricePaise: number;
  arenaName: string;
}

/**
 * The full view of a single booking (GET /v1/consumer/me/bookings/:id). Only the
 * block matching `itemType` is populated: `slots` for court bookings, `event`
 * for event bookings, `membership` for membership purchases.
 */
export interface MyBookingDetail {
  id: string;
  venueId: string | null;
  venueName: string;
  itemType: string;
  status: string;
  channel: string;
  paymentMethod: string;
  totalPaise: number;
  note: string | null;
  customerName: string | null;
  customerContact: string | null;
  /** ISO-8601 */
  createdAt: string;
  slots: MyBookingSlot[];
  event: {
    id: string;
    name: string;
    /** ISO-8601 */
    startsAt: string;
    /** ISO-8601 */
    endsAt: string;
    description: string | null;
  } | null;
  membership: {
    id: string;
    name: string;
    durationDays: number;
    description: string | null;
  } | null;
}

/**
 * A public event with a resolved location. `venueId` is null for org-scoped
 * (venue-less) events; `locationName` is the venue name or the org name.
 */
export interface PublicEventWithVenue extends Omit<PublicEvent, 'venueId'> {
  venueId: string | null;
  venueName: string | null;
  venueTags: string[];
  isStandalone: boolean;
  locationName: string;
  locLat: number | null;
  locLng: number | null;
  locTzName: string;
  locAddressJson: Record<string, unknown> | null;
  /** Uploaded event photos, ordered by position; [] when none (card falls back). */
  images: ImageRef[];
}

/** A membership plus the scope it applies to (venue name, or brand name for
 *  tenant-wide) and the venue tags used to resolve its card image. */
export interface PublicMembershipWithScope extends PublicMembership {
  scopeName: string;
  venueTags: string[];
}
