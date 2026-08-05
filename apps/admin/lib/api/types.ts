// Response shapes consumed by the Admin Console. Keep aligned with
// apps/api/src/routes/admin_*.ts.

/** Shape returned by GET /v1/me/tenants — used to gate the platform check. */
export interface MeTenant {
  id: string;
  name: string;
  slug: string;
  isPlatform: boolean;
}

export interface AdminStats {
  tenantsTotal: number;
  tenantsActive: number;
  tenantsSuspended: number;
  bookings24h: number;
  bookings7d: number;
  // Users / accounts.
  usersTotal: number;
  usersNew24h: number;
  usersNew7d: number;
  // Distinct users with logged consumer activity in the window.
  activeUsers24h: number;
  activeUsers30d: number;
  // Fresh sign-ins recorded via POST /v1/me/login.
  logins24h: number;
  logins7d: number;
}

export interface AdminTenantListItem {
  id: string;
  name: string;
  slug: string;
  status: 'active' | 'suspended';
  subscriptionStatus: string;
  createdAt: string;
  venueCount: number;
  bookingCount30d: number;
}

export interface AdminTenantListPage {
  rows: AdminTenantListItem[];
  nextCursor: string | null;
}

export interface AdminTenantMember {
  userId: string;
  role: 'owner' | 'manager' | 'staff' | 'readonly';
  email: string | null;
  phoneE164: string | null;
  displayName: string | null;
  createdAt: string | null;
}

export interface AdminTenantDetail {
  tenant: {
    id: string;
    name: string;
    slug: string;
    legalEntityName: string | null;
    gstin: string | null;
    panNumber: string | null;
    bankAccountNumber: string | null;
    bankIfsc: string | null;
    bankAccountHolderName: string | null;
    addressJson: Record<string, unknown> | null;
    country: string | null;
    subscriptionStatus: string;
    status: AdminTenantListItem['status'];
    createdAt: string;
    updatedAt: string | null;
  };
  members: AdminTenantMember[];
}

export interface AdminAuditLogItem {
  id: string;
  tenantId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  actorUserId: string | null;
  actorName: string | null;
  before: unknown;
  after: unknown;
  createdAt: string;
}

export interface AdminAuditLogPage {
  rows: AdminAuditLogItem[];
  nextCursor: string | null;
}

// Tenant-scoped audit log (existing /v1/tenants/:id/audit-log) — no tenantId
// field since it's implicit.
export interface TenantAuditLogItem {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  actorUserId: string | null;
  actorName: string | null;
  before: unknown;
  after: unknown;
  createdAt: string;
}

export interface TenantAuditLogPage {
  rows: TenantAuditLogItem[];
  nextCursor: string | null;
}

export interface AdminPayoutRow {
  id: string;
  tenantId: string;
  tenantName: string;
  periodStart: string;
  periodEnd: string;
  grossPaise: number;
  refundsPaise: number;
  commissionPaise: number;
  amountPaise: number;
  currency: string;
  status: 'pending' | 'paid';
  paidAt: string | null;
  paidReference: string | null;
  createdAt: string;
}

export interface AdminPayoutListPage {
  rows: AdminPayoutRow[];
  nextCursor: string | null;
}

export type AdminListingType = 'venue' | 'arena' | 'event' | 'membership';

export interface AdminListingRow {
  type: AdminListingType;
  id: string;
  tenantId: string;
  tenantName: string;
  name: string;
  status: string;
  createdAt: string;
  /** Recurring events queue as one row; this is the series' date count. */
  seriesCount?: number;
}

export interface AdminListingListResponse {
  rows: AdminListingRow[];
}

export interface AdminListingDetail {
  type: AdminListingType;
  id: string;
  tenantId: string;
  tenantName: string;
  name: string;
  status: string;
  createdAt: string;
  // Venue / standalone-event location
  addressJson?: Record<string, unknown> | null;
  lat?: number | null;
  lng?: number | null;
  tzName?: string | null;
  tags?: string[];
  // Arena
  sport?: string | null;
  capacity?: number | null;
  slotDurationMin?: number | null;
  // Event
  description?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  pricePaise?: number | null;
  /** Recurring events: series grouping + total dates in the series. */
  seriesId?: string | null;
  seriesCount?: number;
  // Membership
  durationDays?: number | null;
  benefits?: Record<string, unknown>;
  // Venue link (arena / membership / venue-scoped event)
  venueId?: string | null;
  venueName?: string | null;
}

// ── Event change requests (GET /v1/admin/change-requests) ───────────────────

export interface AdminChangeRequestRow {
  id: string;
  eventId: string;
  tenantId: string;
  tenantName: string;
  eventName: string;
  eventStartsAt: string;
  /** Patch keys the partner wants to change (name, startsAt, tiers, …). */
  fields: string[];
  createdAt: string;
}

export interface AdminChangeRequestListResponse {
  rows: AdminChangeRequestRow[];
}

/** A proposed tier: `id` = update that live tier in place, absent = add. */
export interface AdminChangeRequestTier {
  id?: string;
  name: string;
  description?: string | null;
  pricePaise: number;
  capacity?: number | null;
}

export interface AdminChangeRequestPatch {
  name?: string;
  startsAt?: string;
  endsAt?: string;
  venueId?: string | null;
  addressJson?: Record<string, unknown>;
  lat?: number | null;
  lng?: number | null;
  tzName?: string;
  tiers?: AdminChangeRequestTier[];
}

export interface AdminChangeRequestDetail {
  id: string;
  status: string;
  patch: AdminChangeRequestPatch;
  /** The event's values when the request was made (staleness reference). */
  snapshot: AdminChangeRequestPatch & { tiers?: (AdminChangeRequestTier & { id: string })[] };
  reason: string | null;
  createdAt: string;
  reviewedAt: string | null;
  tenantId: string;
  tenantName: string;
  /** Name of the proposed venue when the patch re-scopes to one. */
  proposedVenueName: string | null;
  /** The event's CURRENT values (re-read at fetch time). */
  event: {
    id: string;
    name: string;
    status: string;
    startsAt: string;
    endsAt: string;
    venueId: string | null;
    venueName: string | null;
    addressJson: Record<string, unknown> | null;
    tzName: string | null;
    tiers: {
      id: string;
      name: string;
      pricePaise: number;
      capacity: number | null;
      sold: number;
      remaining: number | null;
    }[];
  };
}

// ── User reports (GET /v1/admin/users/*) ─────────────────────────────────────

export interface AdminConsumerUserRow {
  id: string;
  displayName: string | null;
  email: string | null;
  phoneE164: string | null;
  interests: string[];
  status: 'active' | 'suspended';
  createdAt: string;
  eventsBooked: number;
  totalBookings: number;
  /** Distinct events viewed, from consumer_activity telemetry. */
  eventsOpened: number;
  sessionCount: number;
  /** Sum of per-session activity spans, in whole minutes. */
  minutesInApp: number;
  lastActiveAt: string | null;
  /** Consumer-app logins only (login_events.source = 'consumer'). */
  loginCount: number;
  lastLoginAt: string | null;
}

export interface AdminConsumerUsersPage {
  rows: AdminConsumerUserRow[];
  nextCursor: string | null;
}

export interface AdminPartnerUserRow {
  userId: string;
  displayName: string | null;
  email: string | null;
  phoneE164: string | null;
  role: 'owner' | 'manager' | 'staff' | 'readonly';
  memberSince: string;
  userCreatedAt: string;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  tenantStatus: 'active' | 'suspended';
  subscriptionStatus: string;
  teamSize: number;
  venueCount: number;
  tenantBookings30d: number;
  /** Partner-portal logins only (login_events.source = 'partners'). */
  loginCount: number;
  lastLoginAt: string | null;
}

export interface AdminPartnerUsersPage {
  rows: AdminPartnerUserRow[];
  nextCursor: string | null;
}

// ── Coupons ───────────────────────────────────────────────────────────────────

export interface Coupon {
  id: string;
  ownerType: 'platform' | 'tenant';
  tenantId: string | null;
  code: string;
  description: string | null;
  scopeType: 'org' | 'venue' | 'event' | 'arena' | 'membership';
  scopeId: string | null;
  discountType: 'percent' | 'fixed';
  discountValue: number;
  maxDiscountPaise: number | null;
  minOrderPaise: number | null;
  visibility: 'public' | 'private';
  validFrom: string | null;
  validUntil: string | null;
  maxRedemptions: number | null;
  perUserLimit: number | null;
  redeemedCount: number;
  status: 'active' | 'paused' | 'expired';
  createdAt: string;
  updatedAt: string;
}

export interface CouponFunderTotals {
  redemptions: number;
  discountPaise: number;
  basePaise: number;
}

export interface CouponStatRow {
  couponId: string;
  code: string;
  redemptions: number;
  discountPaise: number;
  basePaise: number;
}

export interface AdminCouponStats {
  /** Circls-funded discount spend across all tenants. */
  platformFunded: CouponFunderTotals;
  /** Partner-funded discounts across all tenants. */
  orgFunded: CouponFunderTotals;
  /** Per-coupon breakdown of platform (Circls-funded) coupons. */
  byCoupon: CouponStatRow[];
  /** Circls-funded spend per IST month ('YYYY-MM'), oldest→newest. */
  monthly: { month: string; redemptions: number; discountPaise: number }[];
}

// ── Support issues ────────────────────────────────────────────────────────────

export type SupportIssueStatus = 'unresolved' | 'in_progress' | 'backlog' | 'resolved';
export type SupportIssuePriority = 'low' | 'medium' | 'high';
export type SupportIssueSource = 'partner_help' | 'consumer_chatbot';
export type SupportIssueCategory =
  | 'booking_issue'
  | 'refund_request'
  | 'reschedule'
  | 'venue_question'
  | 'payment'
  | 'other';

/** One step of the consumer's MCQ flow (question shown → answer chosen). */
export interface SupportFlowAnswer {
  question: string;
  answer: string;
}

/** Resolved context for the booking a consumer concern is linked to. */
export interface SupportIssueBooking {
  id: string;
  venueName: string | null;
  status: string;
  itemType: string;
}

export interface AdminSupportIssue {
  id: string;
  userId: string;
  message: string;
  status: SupportIssueStatus;
  priority: SupportIssuePriority;
  /** Channel the issue arrived on: partner Help Centre vs consumer Help chatbot. */
  source: SupportIssueSource;
  /** Triage category — only consumer-chatbot concerns carry one. */
  category: SupportIssueCategory | null;
  bookingId: string | null;
  /** The MCQ transcript for a consumer concern; null for partner issues. */
  flowAnswers: SupportFlowAnswer[] | null;
  /** Resolved booking context (null when no booking is linked). */
  booking: SupportIssueBooking | null;
  createdAt: string;
  updatedAt: string;
}

/** Optional filters for the admin support-issues list (#114/#116). */
export interface AdminSupportIssueFilters {
  source?: SupportIssueSource;
  category?: SupportIssueCategory;
  status?: SupportIssueStatus;
}

// ── Questions (consumer support threads) ──────────────────────────────────────
// Keep aligned with apps/api/src/services/questions_service.ts.

/** `general` = support-intake threads with no listing subject (platform tenant). */
export type QuestionSubjectType = 'event' | 'arena' | 'membership' | 'general';
export type QuestionVisibility = 'public' | 'private';
export type QuestionStatus = 'open' | 'answered' | 'closed';
export type QuestionAuthorKind = 'consumer' | 'org' | 'circls';
/** Intake channel: 'forum' (organic ask) or 'support' (Help interview). */
export type QuestionOrigin = 'forum' | 'support';
/** Interview triage category — same six values as support-issue categories. */
export type QuestionCategory = SupportIssueCategory;

/**
 * Subject summary. `general` threads serialize as
 * `{ type: 'general', id: null, name: 'General' }` — the one shape with a null id.
 */
export interface QuestionSubjectSummary {
  type: QuestionSubjectType;
  id: string | null;
  name: string;
}

export interface AdminQuestionThreadRow {
  id: string;
  subjectType: QuestionSubjectType;
  /** Null for `general` threads (no subject row). */
  subjectId: string | null;
  tenantId: string;
  visibility: QuestionVisibility;
  status: QuestionStatus;
  origin: QuestionOrigin;
  /** Null on forum threads. */
  category: QuestionCategory | null;
  /** Booking pinned as context by the support intake; null otherwise. */
  contextBookingId?: string | null;
  /** Excerpt (first 280 chars) of the root message. */
  rootBody: string;
  replyCount: number;
  authorName: string;
  lastMessageAt: string;
  createdAt: string;
  subject?: QuestionSubjectSummary;
  /** ISO timestamp when the thread is archived (hidden from consumers). */
  archivedAt: string | null;
  /** Who archived: 'org' (partner) or 'circls' (admin); null when active. */
  archivedByKind: 'org' | 'circls' | null;
}

export interface AdminQuestionThreadListPage {
  rows: AdminQuestionThreadRow[];
  nextCursor: string | null;
}

export interface QuestionMessageRow {
  id: string;
  threadId: string;
  authorKind: QuestionAuthorKind;
  authorName: string;
  /** True when the message was posted by the calling admin user. */
  own: boolean;
  body: string;
  /** ISO timestamp when hidden by moderation; null when visible. */
  hiddenAt: string | null;
  /** Who hid the message: 'org' (partner) or 'circls' (admin); null when visible. */
  hiddenByKind: 'org' | 'circls' | null;
  createdAt: string;
}

export interface AdminQuestionThreadDetail {
  thread: {
    id: string;
    subjectType: QuestionSubjectType;
    /** Null for `general` threads (no subject row). */
    subjectId: string | null;
    tenantId: string;
    visibility: QuestionVisibility;
    status: QuestionStatus;
    origin: QuestionOrigin;
    /** Null on forum threads. */
    category: QuestionCategory | null;
    /** Booking pinned as context by the support intake; null otherwise. */
    contextBookingId?: string | null;
    /** The support-interview transcript; null on forum threads. */
    flowAnswers?: SupportFlowAnswer[] | null;
    authorUserId: string;
    messageCount: number;
    lastMessageAt: string;
    createdAt: string;
    /** Subject summary (joined name) — always present on detail responses. */
    subject: QuestionSubjectSummary;
    /** Display name of the asker (root-message author). */
    authorName: string;
    /** ISO timestamp when the thread is archived (hidden from consumers). */
    archivedAt: string | null;
    /** Who archived: 'org' (partner) or 'circls' (admin); null when active. */
    archivedByKind: 'org' | 'circls' | null;
  };
  messages: QuestionMessageRow[];
}

/** POST …/messages response: the new message + the (possibly updated) status. */
export interface AdminQuestionReplyResult {
  message: QuestionMessageRow;
  threadStatus: QuestionStatus;
}

/** Optional filters for the admin questions list. */
export interface AdminQuestionFilters {
  status?: QuestionStatus;
  visibility?: QuestionVisibility;
  subjectType?: QuestionSubjectType;
  origin?: QuestionOrigin;
  tenantId?: string;
  /** True selects the archived view; default (false) lists active threads. */
  archived?: boolean;
}

// ── Question thread resolver context ──────────────────────────────────────────
// GET /v1/admin/questions/:threadId/context — keep aligned with
// apps/api/src/services/questions_context_service.ts (admin surface).

export interface QuestionContextMember {
  id: string;
  displayName: string;
  /** When this person joined Circls. */
  memberSince: string;
  /** Always present on the admin surface (null when the user has none). */
  email: string | null;
  phone: string | null;
}

/** One booking row — the pinned booking and the recent list share this shape. */
export interface QuestionContextBooking {
  id: string;
  itemType: string;
  /** Human label: arena / event / membership name (venue name as fallback). */
  label: string;
  status: string;
  totalPaise: number | null;
  currency: string;
  paymentMethod: string;
  timeRange: { start: string; end: string } | null;
  createdAt: string;
}

export interface QuestionContextMembership {
  id: string;
  membershipId: string;
  name: string;
  status: string;
  startsAt: string;
  endsAt: string;
}

export interface QuestionContextPriorThread {
  id: string;
  status: QuestionStatus;
  visibility: QuestionVisibility;
  origin: QuestionOrigin;
  category: QuestionCategory | null;
  subject: QuestionSubjectSummary;
  lastMessageAt: string;
}

export interface QuestionContextActivityRow {
  id: string;
  eventType: string;
  itemType: string | null;
  itemId: string | null;
  props: Record<string, unknown> | null;
  createdAt: string;
}

export interface QuestionContextSupportIssue {
  id: string;
  source: string;
  category: string | null;
  status: string;
  /** First 280 chars of the free-text message. */
  messageExcerpt: string;
  createdAt: string;
}

export interface AdminQuestionThreadContext {
  member: QuestionContextMember;
  /** The booking pinned by the support intake; null when none. */
  contextBooking: QuestionContextBooking | null;
  /** Cross-tenant, latest 10. */
  recentBookings: QuestionContextBooking[];
  memberships: QuestionContextMembership[];
  /** Cross-tenant, latest 10, excludes the current thread. */
  priorThreads: QuestionContextPriorThread[];
  /** Latest 20 consumer-activity rows. */
  recentActivity: QuestionContextActivityRow[];
  /** Historical support_issues by the same user, latest 10. */
  supportIssues: QuestionContextSupportIssue[];
}
