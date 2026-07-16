// Local mirror of the API response shapes the portal consumes. (A shared
// @circls/api-types package is a future consolidation; kept local for now.)
export interface User {
  id: string;
  firebaseUid: string;
  phoneE164: string | null;
  email: string | null;
  displayName: string | null;
  status: 'active' | 'suspended';
}

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  isPlatform?: boolean;
  subscriptionStatus: string;
  status: string;
}

/** Social handles/URLs an org advertises (PR #107). All optional. */
export interface TenantSocials {
  instagram?: string;
  facebook?: string;
  x?: string;
  youtube?: string;
}

/**
 * The editable org/brand profile (PR #107) as returned by GET /v1/tenants/:id
 * and PATCH /v1/tenants/:id. `logoUrl` is the derived public R2 URL (null when
 * no logo is set).
 */
export interface TenantProfile {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  websiteUrl: string | null;
  socials: TenantSocials | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  logoStorageKey: string | null;
  logoUrl: string | null;
  status: string;
}

/**
 * Listing lifecycle status (subproject B). New venues/arenas are created as
 * `pending_review` and must be approved by Circls before they go live; admins
 * may also `reject` them. Partners only view these here.
 */
export type ListingStatus =
  | 'pending_review'
  | 'active'
  | 'rejected'
  | 'suspended'
  | 'inactive';

/** Per-weekday opening hours (PR #109): keys "0"–"6" (0 = Sunday); empty/missing
 *  array = closed that day; times are venue-local "HH:MM". */
export type OpeningHours = Record<string, { open: string; close: string }[]>;

export interface Venue {
  id: string;
  tenantId: string;
  name: string;
  tzName: string;
  lat: number | null;
  lng: number | null;
  status: ListingStatus;
  tags: string[];
  // Trust metadata (PR #109). Present on GET /v1/venues/:id; nullable.
  description?: string | null;
  amenities?: string[];
  openingHours?: OpeningHours | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
}

// ── QR tickets ────────────────────────────────────────────────────────────────

/**
 * QR ticket issuance rules on an event / arena / membership. Stored as JSONB;
 * `null` on the row = QR tickets disabled. The rules are frozen onto each pass
 * at issuance — edits only affect future purchases.
 */
export interface QrTicketConfig {
  enabled: boolean;
  /** false = single-use (spent by the first successful scan). */
  multiUse: boolean;
  /** Scan cap for multi-use passes; null = unlimited. Ignored when single-use. */
  maxScans: number | null;
  /** Minutes before the item starts that the pass becomes valid; null = valid on issue. */
  validFromOffsetMin: number | null;
  /** Minutes after the item ends that the pass expires; null = expires at item end. */
  validUntilOffsetMin: number | null;
}

export type QrScanOutcome =
  | 'valid'
  | 'not_found'
  | 'revoked'
  | 'expired'
  | 'not_yet_valid'
  | 'already_used';

/** What door staff sees after a scan — enough to admit or turn away. */
export interface QrScanTicket {
  id: string;
  itemType: string;
  label: string | null;
  bookingId: string | null;
  customerName: string | null;
  /** ISO-8601, or null = valid from issue. */
  validFrom: string | null;
  /** ISO-8601, or null = never expires. */
  validUntil: string | null;
  multiUse: boolean;
  maxScans: number | null;
  scanCount: number;
  firstScannedAt: string | null;
  lastScannedAt: string | null;
  status: string;
}

export interface QrScanResult {
  outcome: QrScanOutcome;
  /** null only for not_found. */
  ticket: QrScanTicket | null;
}

/** Last-used schedule-builder template, persisted per arena for prefill. */
export interface ScheduleTemplate {
  quantizationMin: number;
  defaultPriceRupees: number;
  bands: { startMin: number; endMin: number; priceRupees: number }[];
}

export interface Arena {
  id: string;
  venueId: string;
  name: string;
  sport: string | null;
  slotDurationMin: number;
  /** Minute-of-day the business day begins (default 180 = 3am). */
  businessDayStartMin: number;
  /** Last-used builder template, or null before the first release. */
  scheduleTemplate: ScheduleTemplate | null;
  /** QR ticket rules for bookings on this arena; null = disabled. */
  qrTicketConfig: QrTicketConfig | null;
  status: ListingStatus;
  tags: string[];
}

/** A venue photo. `url` is the public, CDN-cacheable R2 URL to render. */
export interface VenueImage {
  id: string;
  venueId: string;
  storageKey: string;
  url: string;
  mimeType: string;
  sizeBytes: number | null;
  position: number;
  createdAt: string;
}

/** An event photo. `url` is the public, CDN-cacheable R2 URL to render. */
export interface EventImage {
  id: string;
  eventId: string;
  storageKey: string;
  url: string;
  mimeType: string;
  sizeBytes: number | null;
  position: number;
  createdAt: string;
}

/** Response from the upload-presign endpoint — the client PUTs to `uploadUrl`. */
export interface PresignedUpload {
  uploadUrl: string;
  storageKey: string;
  headers: Record<string, string>;
  expiresIn: number;
}

export interface Slot {
  id: string;
  tenantId: string;
  arenaId: string;
  timeRange: string;
  pricePaise: number;
  status: 'open' | 'held' | 'blocked' | 'booked';
  holdExpiresAt: string | null;
  bookingId: string | null;
  releaseId: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** ISO-8601 string: lower bound of time_range (from Postgres lower(time_range)). */
  startAt: string;
  /** ISO-8601 string: upper bound of time_range (from Postgres upper(time_range)). */
  endAt: string;
}

export interface Booking {
  id: string;
  slotArenaId: string | null;
  timeRange: string | null;
  status: string;
  channel: string;
  paymentMethod: string;
  pricePaise: number | null;
}

export type BookingStatus = 'pending' | 'confirmed' | 'cancelled' | 'completed' | 'no_show';

export interface BookingListItem {
  id: string;
  customerName: string | null;
  customerContact: string | null;
  note: string | null;
  status: BookingStatus;
  channel: string;
  totalPaise: number;
  createdAt: string;
  arenaId: string;
  arenaName: string;
  firstStartAt: string;
  lastEndAt: string;
  slotCount: number;
}

export interface BookingSlot {
  id: string;
  startAt: string;
  endAt: string;
  pricePaise: number;
  status: string;
  /** Court for this slot — set so multi-court (cart) bookings stay legible. */
  arenaName: string;
}

export interface BookingDetail {
  id: string;
  customerName: string | null;
  customerContact: string | null;
  note: string | null;
  status: BookingStatus;
  channel: string;
  paymentMethod: string;
  totalPaise: number;
  createdAt: string;
  venueId: string;
  arenaId: string;
  arenaName: string;
  slots: BookingSlot[];
}

export interface AnalyticsTrendDay {
  /** 'YYYY-MM-DD' */
  date: string;
  bookings: number;
  revenuePaise: number;
}

/** A revenue bucket: amount in the currency's minor units (paise/cents). */
export interface MoneyByCurrency {
  currency: string;
  amountMinor: number;
}

/** A full 7-day trend for one currency (tenants usually have exactly one). */
export interface AnalyticsTrendSeries {
  currency: string;
  /** 7 entries, oldest → newest (inclusive of today) */
  days: AnalyticsTrendDay[];
}

export interface Analytics {
  bookingsToday: number;
  /** One entry per currency with revenue today; [] when none. */
  revenueToday: MoneyByCurrency[];
  /** One entry per currency with revenue in the window; [] when none. */
  revenue7d: MoneyByCurrency[];
  occupancy7dPct: number;
  /** One series per currency with revenue in the window; [] when none. */
  trend7d: AnalyticsTrendSeries[];
}

export interface AuditLogItem {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  actorUserId: string | null;
  actorName: string | null;
  before: unknown;
  after: unknown;
  /** ISO-8601 */
  createdAt: string;
}

export interface AuditLogPage {
  rows: AuditLogItem[];
  nextCursor: string | null;
}

// ── Notifications (Phase 13) ──────────────────────────────────────────────────

export type NotificationChannel = 'sms' | 'email' | 'whatsapp';
export type NotificationStatus = 'pending' | 'sent' | 'failed' | 'skipped';

export interface NotificationItem {
  id: string;
  channel: NotificationChannel;
  status: NotificationStatus;
  recipient: string;
  templateKey: string;
  providerMessageId: string | null;
  error: string | null;
  /** ISO-8601 — null when not scheduled (sent immediately). */
  scheduledFor: string | null;
  /** ISO-8601 — null while still pending or failed. */
  sentAt: string | null;
  /** ISO-8601 */
  createdAt: string;
}

export interface NotificationsPage {
  rows: NotificationItem[];
  nextCursor: string | null;
}

// ── Phase 14: cancellations + payments ledger ────────────────────────────────

export interface CancelResult {
  bookingId: string;
  status: 'cancelled';
  refundPaise: number;
  refundId?: string;
  policy: 'full' | 'partial' | 'none' | 'override' | 'free' | 'external';
}

export type PaymentKind = 'charge' | 'refund' | 'adjustment';
export type PaymentStatus =
  | 'pending'
  | 'authorized'
  | 'captured'
  | 'failed'
  | 'refunded'
  | 'partially_refunded';

export interface Payment {
  id: string;
  bookingId: string;
  tenantId: string;
  provider: 'razorpay' | 'stub' | 'external';
  providerOrderId: string | null;
  providerPaymentId: string | null;
  /** Signed: positive for charges, negative for refunds. Paise. */
  amountPaise: number;
  currency: string;
  status: PaymentStatus;
  kind: PaymentKind;
  metadata: Record<string, unknown>;
  settlementHoldUntil: string | null;
  settlementReleasedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Events (Phase 15) ────────────────────────────────────────────────────────

export type EventStatus =
  | 'draft'
  | 'pending_review'
  | 'published'
  | 'rejected'
  | 'cancelled';

export interface VenueEvent {
  id: string;
  tenantId: string;
  venueId: string | null;
  addressJson: Record<string, unknown> | null;
  lat: number | null;
  lng: number | null;
  tzName: string | null;
  name: string;
  description: string | null;
  /** ISO-8601 */
  startsAt: string;
  /** ISO-8601 */
  endsAt: string;
  pricePaise: number;
  capacity: number | null;
  status: EventStatus;
  /** QR ticket rules for registrations; null = disabled. */
  qrTicketConfig: QrTicketConfig | null;
  /** Groups the dates of a recurring event; null for one-off events. */
  seriesId: string | null;
  /** Ticket tiers for the event (min 1). Present on the detail endpoint. */
  tiers: EventTier[];
}

/**
 * Event as returned by the LIST endpoints (venue/tenant). Same shape as
 * {@link VenueEvent} but without the per-event `tiers` array, which only the
 * detail endpoint hydrates. `pricePaise` is kept in sync as the min tier price.
 */
export type VenueEventSummary = Omit<VenueEvent, 'tiers'>;

/** A ticket tier on an event, with live sold/remaining counts. */
export interface EventTier {
  id: string;
  name: string;
  description: string | null;
  pricePaise: number;
  capacity: number | null;
  /** Per-tier QR override; null = inherit the event's `qrTicketConfig`. */
  qrTicketConfig: QrTicketConfig | null;
  sold: number;
  remaining: number | null;
}

/** A consumer registration for an event (partner-facing). */
export interface EventBooking {
  id: string;
  customerName: string | null;
  customerContact: string | null;
  /** From the linked user account, falling back to `customerContact` when it looks like an email. */
  customerEmail: string | null;
  /** From the linked user account, falling back to `customerContact` when it looks like a phone. */
  customerPhone: string | null;
  status: string;
  totalPaise: number;
  /** ISO-8601 */
  createdAt: string;
}

// ── Memberships (Phase 15) ───────────────────────────────────────────────────

/** A single membership perk (PR #110). */
export interface MembershipBenefitItem {
  label: string;
  detail?: string;
}
/** Typed membership benefits (PR #110). */
export interface MembershipBenefits {
  items: MembershipBenefitItem[];
}

/** A plan tier on a membership, with live sold/remaining counts. */
export interface MembershipTier {
  id: string;
  name: string;
  description: string | null;
  pricePaise: number;
  durationDays: number;
  benefits: MembershipBenefits;
  capacity: number | null;
  /** Per-tier QR override: null = inherit the plan config; enabled:false = off
   *  for this tier; enabled:true = custom rules. */
  qrTicketConfig: QrTicketConfig | null;
  sold: number;
  remaining: number | null;
}

export interface Membership {
  id: string;
  tenantId: string;
  venueId: string | null;
  name: string;
  description: string | null;
  /** Legacy display fields — mirror the cheapest tier. */
  pricePaise: number;
  durationDays: number;
  benefits: MembershipBenefits;
  /** Plan terms & conditions (PR #110). */
  terms?: string | null;
  /** R2 object key of the cover artwork (PR #110); use derived URLs via the API. */
  coverStorageKey?: string | null;
  /** Derived public artwork URL on partner list/cover responses (PR #110). */
  coverUrl?: string | null;
  status: 'pending_review' | 'active' | 'rejected' | 'inactive' | 'suspended';
  /** QR ticket rules for purchases of this plan; null = disabled. */
  qrTicketConfig: QrTicketConfig | null;
  /** Plan tiers (min 1). Present on list + detail endpoints. */
  tiers: MembershipTier[];
}

export interface UserMembership {
  id: string;
  userId: string;
  membershipId: string;
  paymentId: string | null;
  startsAt: string;
  endsAt: string;
  status: 'active' | 'expired' | 'cancelled';
  membership: {
    id: string;
    tenantId: string;
    venueId: string | null;
    name: string;
    description: string | null;
    pricePaise: number;
    durationDays: number;
  };
}

/** A consumer purchase of a membership plan (partner-facing). */
export interface MembershipPurchase {
  userMembershipId: string;
  buyerName: string;
  buyerContact: string;
  /** The tier the buyer purchased, or null for legacy purchases. */
  tierName: string | null;
  status: string;
  /** ISO-8601 */
  startsAt: string;
  /** ISO-8601 */
  endsAt: string;
  /** ISO-8601 */
  createdAt: string;
}

// ── Phase 17: API keys + outbound webhooks ────────────────────────────────────

export interface ApiKey {
  id: string;
  tenantId: string | null;
  name: string;
  keyPrefix: string;
  role: 'read' | 'write' | 'admin';
  scopes: string[];
  status: 'active' | 'revoked';
  lastUsedAt: string | null;
  createdAt: string;
}

export interface ApiKeyCreateResult {
  id: string;
  /** Shown ONCE — partner must copy it now. */
  plaintext: string;
  prefix: string;
}

export interface WebhookSubscription {
  id: string;
  tenantId: string;
  url: string;
  events: string[];
  status: 'active' | 'disabled';
  createdAt: string;
}

export interface WebhookSubscriptionCreateResult {
  id: string;
  /** Shown ONCE — partner must copy it now. */
  secret: string;
}

export type WebhookDeliveryStatus = 'pending' | 'delivered' | 'failed' | 'expired';

export interface WebhookDeliveryItem {
  id: string;
  eventType: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
}

export interface WebhookDeliveryPage {
  rows: WebhookDeliveryItem[];
  nextCursor: string | null;
}

// Team management (subproject D).
export type TenantRole = 'owner' | 'manager' | 'staff' | 'readonly';

export interface TeamMember {
  userId: string;
  email: string | null;
  displayName: string | null;
  role: TenantRole;
  createdAt: string;
}

export interface TenantInvitation {
  id: string;
  tenantId: string;
  email: string;
  role: TenantRole;
  invitedByUserId: string;
  expiresAt: string;
  acceptedAt: string | null;
  acceptedUserId: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface CreateInvitationResponse {
  invitation: TenantInvitation;
  token: string; // shown once for copy-link
}

// ── Support issues ────────────────────────────────────────────────────────────

export type SupportIssueStatus = 'unresolved' | 'in_progress' | 'backlog' | 'resolved';
export type SupportIssuePriority = 'low' | 'medium' | 'high';

export interface SupportIssue {
  id: string;
  userId: string;
  message: string;
  status: SupportIssueStatus;
  priority: SupportIssuePriority;
  createdAt: string;
  updatedAt: string;
}

// ── Activity (partner Activity page) ─────────────────────────────────────────

export type ActivityItemType = 'slot' | 'event' | 'membership';

export interface ActivityItem {
  id: string;
  itemType: ActivityItemType;
  status: string;
  channel: string;
  customerName: string | null;
  customerContact: string | null;
  totalPaise: number | null;
  /** ISO-8601 — when the booking/purchase was made. */
  createdAt: string;
  venueId: string | null;
  venueName: string | null;
  /** Arena label (slot), event name, or membership plan name. */
  itemName: string | null;
  tierName: string | null;
  /** Session start/end (slot/event) or membership validity window. */
  startAt: string | null;
  endAt: string | null;
}

export interface ActivityPage {
  rows: ActivityItem[];
  nextCursor: string | null;
}

export interface ActivityDailyCount {
  /** 'YYYY-MM-DD' in the requested timezone. */
  date: string;
  bookings: number;
}

export interface MembershipWindowItem {
  userMembershipId: string;
  buyerName: string | null;
  buyerContact: string | null;
  membershipName: string;
  tierName: string | null;
  status: string;
  startsAt: string;
  endsAt: string;
}

export interface MembershipWindows {
  starting: MembershipWindowItem[];
  ending: MembershipWindowItem[];
}
