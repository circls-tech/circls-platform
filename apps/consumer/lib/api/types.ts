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
  /** Per-customer ticket cap for the whole event (all tiers); null = no limit. */
  maxPerUser: number | null;
  status: 'published';
  /** Consumer discovery/entry mode. `unlisted` events never appear in lists. */
  visibility: 'public' | 'unlisted' | 'access_code';
  /** True for an access_code event until the right code is presented — tiers
   *  stay [] and booking is refused server-side. */
  locked: boolean;
  /** Owning-org summary (PR #108). */
  brand: Brand;
  /** Ticket tiers; [] on list/upcoming responses, populated on the detail view. */
  tiers: PublicTier[];
  /** Recurring events: groups the series' dates; null/absent for one-offs. */
  seriesId?: string | null;
  /** Upcoming dates in the series (list rows show the next one); 1 for one-offs. */
  seriesCount?: number;
}

/** One bookable date of a recurring event, for the date picker. */
export interface PublicSeriesOccurrence {
  id: string;
  /** ISO-8601 */
  startsAt: string;
  /** ISO-8601 */
  endsAt: string;
  /** Venue name, or the org name for standalone dates. */
  locationName: string;
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

/** A plan tier on a membership. `remaining` is `capacity - sold`, or null when
 *  the tier is uncapped. */
export interface PublicMembershipTier {
  id: string;
  name: string;
  description: string | null;
  pricePaise: number;
  durationDays: number;
  benefits: MembershipBenefits;
  capacity: number | null;
  remaining: number | null;
}

export interface PublicMembership {
  id: string;
  tenantId: string;
  venueId: string | null;
  name: string;
  description: string | null;
  /** Legacy display fields — mirror the cheapest tier. */
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
  /** Plan tiers (min 1). */
  tiers: PublicMembershipTier[];
}

// ── Booking / purchase results ────────────────────────────────────────────────

export interface SlotBookingResult {
  bookingId: string;
  payment: {
    /** Which gateway to open checkout on — Stripe for US venues. */
    gateway: 'razorpay' | 'stripe';
    orderId: string;
    /** The gateway's browser-safe key (Razorpay key id / Stripe publishable
     *  key). Empty string in stub mode (no live keys configured). */
    keyId: string;
    /** Stripe only: the PaymentIntent client secret. */
    clientSecret?: string;
    amountPaise: number;
    currency: string;
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
  /** Which gateway to open checkout on (paid only) — Stripe for US venues. */
  gateway?: 'razorpay' | 'stripe';
  /** The gateway's browser-safe key + amount for opening checkout (paid only). */
  keyId?: string;
  /** Stripe only: the PaymentIntent client secret. */
  clientSecret?: string;
  amountPaise?: number;
  currency?: string;
}

export interface MembershipPurchaseResult {
  userMembershipId: string;
  paymentId?: string;
  /** Present only for paid memberships; free ones activate immediately. */
  orderId?: string;
  /** Which gateway to open checkout on (paid only) — Stripe for US venues. */
  gateway?: 'razorpay' | 'stripe';
  /** The gateway's browser-safe key + amount for opening checkout (paid only). */
  keyId?: string;
  /** Stripe only: the PaymentIntent client secret. */
  clientSecret?: string;
  amountPaise?: number;
  currency?: string;
}

// ── Booking / purchase inputs ─────────────────────────────────────────────────

export interface PurchaseMembershipInput {
  membershipId: string;
  /** The tier to buy; omit for a single-tier plan (server picks the cheapest). */
  membershipTierId?: string;
  couponCode?: string;
}

export interface MyBooking {
  id: string;
  venueId: string | null;
  venueName: string;
  itemType: string;
  status: string;
  totalPaise: number;
  /** ISO 4217 — totalPaise is in this currency's minor units. */
  currency: string;
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

/** A scannable entry ticket attached to a confirmed booking. */
export interface QrTicket {
  id: string;
  /** e.g. "General · 1 of 3", an arena name, or a plan name. */
  label: string | null;
  /** String to encode in the QR image (a check-in URL). */
  qrData: string;
  /** Short opaque token — shown as fallback text when the QR can't be scanned. */
  code: string;
  /** ISO-8601; null = valid immediately. */
  validFrom: string | null;
  /** ISO-8601; null = no expiry. */
  validUntil: string | null;
  multiUse: boolean;
  maxScans: number | null;
  scanCount: number;
  status: 'active' | 'used' | 'revoked';
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
  /** ISO 4217 — totalPaise/slot prices are in this currency's minor units. */
  currency: string;
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
  /** Scannable entry tickets; [] until the booking is confirmed. */
  qrTickets: QrTicket[];
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
  /** Every upcoming date of a recurring event (detail view only), soonest first. */
  seriesOccurrences?: PublicSeriesOccurrence[];
}

/** A membership plus the scope it applies to (venue name, or brand name for
 *  tenant-wide) and the venue tags used to resolve its card image. */
export interface PublicMembershipWithScope extends PublicMembership {
  scopeName: string;
  venueTags: string[];
  /** Owning venue's city for venue-scoped plans; null for tenant-wide (a brand
   *  pass isn't city-bound) or when the venue has no city on file. */
  city: string | null;
  /** Owning venue's coordinates for venue-scoped plans (drives the "near you"
   *  radius); null for tenant-wide or ungeocoded venues. */
  lat: number | null;
  lng: number | null;
  /** Country the plan's prices are denominated in (owning venue's country,
   *  falling back to the tenant's) — drives the display currency. */
  country: string | null;
}

// ── Questions threads (support Q&A on events / arenas / memberships) ──────────

export type QuestionSubjectType = 'event' | 'arena' | 'membership' | 'general';
/** Subject types with a listing page — `general` (support-only) has none. */
export type ListableQuestionSubjectType = Exclude<QuestionSubjectType, 'general'>;
export type QuestionVisibility = 'public' | 'private';
export type QuestionStatus = 'open' | 'answered' | 'closed';
export type QuestionAuthorKind = 'consumer' | 'org' | 'circls';
/** Intake channel: organic ask ('forum') vs Help-widget interview ('support'). */
export type QuestionOrigin = 'forum' | 'support';
/** Help-interview triage category; null on forum threads. */
export type QuestionCategory =
  | 'booking_issue'
  | 'refund_request'
  | 'reschedule'
  | 'venue_question'
  | 'payment'
  | 'other';

/** Subject summary. `general` threads (support questions with no listing
 *  subject) serialize as `{ type: 'general', id: null, name: 'General' }` —
 *  the one subject shape with a null id. */
export interface QuestionSubjectSummary {
  type: QuestionSubjectType;
  id: string | null;
  name: string;
}

/** A thread row in a questions list (GET /v1/consumer/questions[/mine]). */
export interface QuestionThreadListRow {
  id: string;
  subjectType: QuestionSubjectType;
  /** Null for `general` threads (no subject row). */
  subjectId: string | null;
  tenantId: string;
  visibility: QuestionVisibility;
  status: QuestionStatus;
  /** Intake channel: 'forum' (organic ask) or 'support' (Help interview). */
  origin: QuestionOrigin;
  /** Interview triage category; null on forum threads. */
  category: QuestionCategory | null;
  /** Excerpt of the root message (first 280 chars). */
  rootBody: string;
  replyCount: number;
  authorName: string;
  /** ISO-8601 — bumped on every message; lists sort by it, newest first. */
  lastMessageAt: string;
  /** ISO-8601 */
  createdAt: string;
  /** Subject summary — present on /mine rows so the list can name the subject. */
  subject?: QuestionSubjectSummary;
}

/** A cursor page of question threads. */
export interface QuestionThreadListPage {
  rows: QuestionThreadListRow[];
  nextCursor: string | null;
}

/** One message in a thread. Hidden messages are only returned to viewers
 *  allowed to see them (the message author, the org, Circls staff). */
export interface QuestionMessageRow {
  id: string;
  threadId: string;
  authorKind: QuestionAuthorKind;
  authorName: string;
  /** True when the message was posted by the signed-in viewer (false signed-out). */
  own: boolean;
  body: string;
  /** ISO-8601 when moderated away, else null. */
  hiddenAt: string | null;
  /** ISO-8601 */
  createdAt: string;
}

/** Full thread view (GET /v1/consumer/questions/:threadId). The root message
 *  is the earliest entry of `messages`. */
export interface QuestionThreadDetail {
  thread: {
    id: string;
    subjectType: QuestionSubjectType;
    /** Null for `general` threads (no subject row). */
    subjectId: string | null;
    tenantId: string;
    visibility: QuestionVisibility;
    status: QuestionStatus;
    /** Intake channel: 'forum' (organic ask) or 'support' (Help interview). */
    origin: QuestionOrigin;
    /** Interview triage category; null on forum threads. */
    category: QuestionCategory | null;
    /** DB user id of the asker — compare against MyProfile.id, not the Firebase uid. */
    authorUserId: string;
    messageCount: number;
    /** ISO-8601 */
    lastMessageAt: string;
    /** ISO-8601 */
    createdAt: string;
    /** Subject summary (joined name) — always present on detail responses. */
    subject: QuestionSubjectSummary;
    /** Display name of the asker (root-message author). */
    authorName: string;
  };
  messages: QuestionMessageRow[];
}

/** Body of POST /v1/consumer/questions (forum ask on a listed subject). */
export interface AskQuestionInput {
  subjectType: ListableQuestionSubjectType;
  subjectId: string;
  visibility: QuestionVisibility;
  /** 1–2000 chars. */
  body: string;
}

/**
 * Body of POST /v1/consumer/questions for the Help-widget support intake.
 * No subjectType/visibility: the server derives the subject from the booking
 * (or `general` when none) and forces the thread private. Returns the same
 * QuestionThreadDetail as a forum ask. Errors: 404 `booking_not_found`,
 * 429 `question_rate_limited`, 400 `bad_request`.
 */
export interface SupportThreadInput {
  origin: 'support';
  category: QuestionCategory;
  /** 1–2000 chars — becomes the thread's root message. */
  body: string;
  /** Must be the caller's own (non-cancelled) booking. */
  bookingId?: string;
  /** Interview transcript for staff; ≤50 entries, fields 1–500 chars. */
  flowAnswers?: { question: string; answer: string }[];
}

/** Result of POST /v1/consumer/questions/:threadId/messages. */
export interface QuestionReplyResult {
  message: QuestionMessageRow;
  /** The thread status after the reply's auto-transitions applied. */
  threadStatus: QuestionStatus;
}

// ── My profile ────────────────────────────────────────────────────────────────

/** The signed-in consumer's own profile (GET/PATCH /v1/consumer/me). */
export interface MyProfile {
  id: string;
  phoneE164: string | null;
  email: string | null;
  displayName: string | null;
  interests: string[];
}
