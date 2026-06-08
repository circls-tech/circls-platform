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

export interface AdminSupportIssue {
  id: string;
  userId: string;
  message: string;
  status: SupportIssueStatus;
  priority: SupportIssuePriority;
  createdAt: string;
  updatedAt: string;
}
