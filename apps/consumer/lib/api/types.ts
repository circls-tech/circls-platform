// Local mirror of the consumer API response shapes (apps/api/src/routes/consumer.ts).
// Mirrors the partner portal's convention of keeping a local types file rather
// than sharing a package across apps.

/** An uploaded photo reference (public R2 URL), ordered by position (0 = cover). */
export interface ImageRef {
  url: string;
  position: number;
}

export interface PublicVenue {
  id: string;
  name: string;
  tags: string[];
  lat: number | null;
  lng: number | null;
  addressJson: Record<string, unknown> | null;
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
}

export interface PublicMembership {
  id: string;
  tenantId: string;
  venueId: string | null;
  name: string;
  description: string | null;
  pricePaise: number;
  durationDays: number;
  benefits: Record<string, unknown>;
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
