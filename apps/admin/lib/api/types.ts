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
    razorpayLinkedAccountId: string | null;
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
  // Membership
  durationDays?: number | null;
  benefits?: Record<string, unknown>;
  // Venue link (arena / membership / venue-scoped event)
  venueId?: string | null;
  venueName?: string | null;
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
