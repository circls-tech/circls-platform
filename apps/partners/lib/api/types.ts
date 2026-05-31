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

export interface Venue {
  id: string;
  tenantId: string;
  name: string;
  tzName: string;
  lat: number | null;
  lng: number | null;
  status: ListingStatus;
  tags: string[];
}

export interface Arena {
  id: string;
  venueId: string;
  name: string;
  sport: string | null;
  slotDurationMin: number;
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

export interface Analytics {
  bookingsToday: number;
  revenueTodayPaise: number;
  revenue7dPaise: number;
  occupancy7dPct: number;
  /** 7 entries, oldest → newest (inclusive of today) */
  trend7d: AnalyticsTrendDay[];
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
}

/** A consumer registration for an event (partner-facing). */
export interface EventBooking {
  id: string;
  customerName: string;
  customerContact: string;
  status: string;
  totalPaise: number;
  /** ISO-8601 */
  createdAt: string;
}

// ── Memberships (Phase 15) ───────────────────────────────────────────────────

export interface Membership {
  id: string;
  tenantId: string;
  venueId: string | null;
  name: string;
  description: string | null;
  pricePaise: number;
  durationDays: number;
  benefits: Record<string, unknown>;
  status: 'pending_review' | 'active' | 'rejected' | 'inactive' | 'suspended';
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
