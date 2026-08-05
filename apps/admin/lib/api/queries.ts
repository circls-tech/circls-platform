import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/lib/firebase/auth_context';
import { apiFetch } from './client';
import type {
  AdminAuditLogPage,
  AdminConsumerUsersPage,
  AdminCouponStats,
  AdminListingDetail,
  AdminListingListResponse,
  AdminListingType,
  AdminPartnerUsersPage,
  AdminPayoutListPage,
  AdminQuestionFilters,
  AdminQuestionReplyResult,
  AdminQuestionThreadContext,
  AdminQuestionThreadDetail,
  AdminQuestionThreadListPage,
  AdminStats,
  AdminSupportIssue,
  AdminSupportIssueFilters,
  AdminTenantDetail,
  AdminTenantListPage,
  Coupon,
  QuestionMessageRow,
  QuestionStatus,
  SupportIssueStatus,
  SupportIssuePriority,
  TenantAuditLogPage,
} from './types';

function qs(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== '');
  if (entries.length === 0) return '';
  const sp = new URLSearchParams();
  for (const [k, v] of entries) sp.set(k, String(v));
  return `?${sp.toString()}`;
}

export function useAdminStats() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['admin', 'stats'],
    enabled: Boolean(user),
    queryFn: () => apiFetch<AdminStats>('/v1/admin/stats'),
  });
}

export function useAdminTenants(searchQuery?: string) {
  const { user } = useAuth();
  return useInfiniteQuery({
    queryKey: ['admin', 'tenants', searchQuery ?? ''],
    enabled: Boolean(user),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      apiFetch<AdminTenantListPage>(
        `/v1/admin/tenants${qs({ limit: 50, cursor: pageParam, q: searchQuery })}`,
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useAdminTenantDetail(id: string | null) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['admin', 'tenant', id],
    enabled: Boolean(user && id),
    queryFn: () => apiFetch<AdminTenantDetail>(`/v1/admin/tenants/${id!}`),
  });
}

export function useSuspendTenant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<unknown>(`/v1/admin/tenants/${id}/suspend`, { method: 'POST' }),
    onSuccess: (_data, id) => {
      void qc.invalidateQueries({ queryKey: ['admin', 'tenants'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'tenant', id] });
      void qc.invalidateQueries({ queryKey: ['admin', 'stats'] });
    },
  });
}

export function useReactivateTenant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<unknown>(`/v1/admin/tenants/${id}/reactivate`, { method: 'POST' }),
    onSuccess: (_data, id) => {
      void qc.invalidateQueries({ queryKey: ['admin', 'tenants'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'tenant', id] });
      void qc.invalidateQueries({ queryKey: ['admin', 'stats'] });
    },
  });
}

// ── User reports ──────────────────────────────────────────────────────────────

export interface AdminUserReportFilters {
  q?: string;
  /** ISO instant; only rows created at/after it ("new since…"). */
  since?: string;
}

export function useAdminConsumerUsers(filters: AdminUserReportFilters) {
  const { user } = useAuth();
  return useInfiniteQuery({
    queryKey: ['admin', 'users', 'consumers', filters],
    enabled: Boolean(user),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      apiFetch<AdminConsumerUsersPage>(
        `/v1/admin/users/consumers${qs({ limit: 50, cursor: pageParam, ...filters })}`,
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useAdminPartnerUsers(filters: AdminUserReportFilters) {
  const { user } = useAuth();
  return useInfiniteQuery({
    queryKey: ['admin', 'users', 'partners', filters],
    enabled: Boolean(user),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      apiFetch<AdminPartnerUsersPage>(
        `/v1/admin/users/partners${qs({ limit: 50, cursor: pageParam, ...filters })}`,
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export interface AdminAuditLogFilters {
  tenantId?: string;
  actorUserId?: string;
  entityType?: string;
  entityId?: string;
  action?: string;
  since?: string;
  until?: string;
}

export function useAdminAuditLog(filters: AdminAuditLogFilters) {
  const { user } = useAuth();
  return useInfiniteQuery({
    queryKey: ['admin', 'audit-log', filters],
    enabled: Boolean(user),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      apiFetch<AdminAuditLogPage>(
        `/v1/admin/audit-log${qs({ limit: 50, cursor: pageParam, ...filters })}`,
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useAdminPayouts(status?: 'pending' | 'paid') {
  const { user } = useAuth();
  return useInfiniteQuery({
    queryKey: ['admin', 'payouts', status ?? ''],
    enabled: Boolean(user),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      apiFetch<AdminPayoutListPage>(
        `/v1/admin/payouts${qs({ limit: 50, cursor: pageParam, status })}`,
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useExecutePayout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; reference: string; note?: string }) =>
      apiFetch<unknown>(`/v1/admin/payouts/${args.id}/execute`, {
        method: 'POST',
        body: JSON.stringify({ reference: args.reference, note: args.note }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'payouts'] });
    },
  });
}

/**
 * Listing review queue (subproject B). `type` is required by the backend;
 * `status` defaults to pending_review server-side. No cursor pagination —
 * the endpoint returns up to 200 rows, so a plain useQuery is enough.
 */
export function useAdminListings(type: AdminListingType | null, status?: string) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['admin', 'listings', type, status ?? ''],
    enabled: Boolean(user && type),
    queryFn: () =>
      apiFetch<AdminListingListResponse>(`/v1/admin/listings${qs({ type: type!, status })}`),
  });
}

export function useAdminListingDetail(type: AdminListingType | null, id: string | null) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['admin', 'listing-detail', type, id],
    enabled: Boolean(user && type && id),
    queryFn: () => apiFetch<AdminListingDetail>(`/v1/admin/listings/${type!}/${id!}`),
  });
}

export function useApproveListing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { type: AdminListingType; id: string }) =>
      apiFetch<{ id: string; status: string }>(
        `/v1/admin/listings/${args.type}/${args.id}/approve`,
        { method: 'POST' },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'listings'] });
    },
  });
}

export function useRejectListing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { type: AdminListingType; id: string; reason?: string }) =>
      apiFetch<{ id: string; status: string }>(
        `/v1/admin/listings/${args.type}/${args.id}/reject`,
        { method: 'POST', body: JSON.stringify({ reason: args.reason }) },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'listings'] });
    },
  });
}

/** Tenant-scoped audit log (the existing route Track A shipped). */
export function useTenantAuditLog(tenantId: string | null) {
  const { user } = useAuth();
  return useInfiniteQuery({
    queryKey: ['admin', 'tenant-audit-log', tenantId],
    enabled: Boolean(user && tenantId),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      apiFetch<TenantAuditLogPage>(
        `/v1/tenants/${tenantId!}/audit-log${qs({ limit: 50, cursor: pageParam })}`,
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

// ── Support issues ────────────────────────────────────────────────────────────

export function useAdminSupportIssues(filters: AdminSupportIssueFilters = {}) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['admin', 'support-issues', filters.source ?? '', filters.category ?? '', filters.status ?? ''],
    enabled: Boolean(user),
    queryFn: () =>
      apiFetch<AdminSupportIssue[]>(
        `/v1/admin/support-issues${qs({
          source: filters.source,
          category: filters.category,
          status: filters.status,
        })}`,
      ),
  });
}

export function useUpdateSupportIssue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status, priority }: { id: string; status?: SupportIssueStatus; priority?: SupportIssuePriority }) =>
      apiFetch<AdminSupportIssue>(`/v1/admin/support-issues/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status, priority }),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin', 'support-issues'] }),
  });
}

// ── Questions (consumer support threads) ──────────────────────────────────────

export function useAdminQuestions(filters: AdminQuestionFilters = {}) {
  const { user } = useAuth();
  const { archived, ...rest } = filters;
  return useInfiniteQuery({
    queryKey: ['admin', 'questions', filters],
    enabled: Boolean(user),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      apiFetch<AdminQuestionThreadListPage>(
        `/v1/admin/questions${qs({
          limit: 50,
          cursor: pageParam,
          ...rest,
          // Server default is the active view; only the archived view is opt-in.
          ...(archived ? { archived: 'true' } : {}),
        })}`,
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useAdminQuestionThread(threadId: string | null) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['admin', 'question', threadId],
    enabled: Boolean(user && threadId),
    queryFn: () => apiFetch<AdminQuestionThreadDetail>(`/v1/admin/questions/${threadId!}`),
  });
}

/**
 * Resolver context for a thread: who the asker is (contact details included),
 * the pinned booking, cross-tenant bookings/memberships/prior threads, recent
 * consumer activity and historical support issues.
 */
export function useAdminQuestionContext(threadId: string | null) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['admin', 'question-context', threadId],
    enabled: Boolean(user && threadId),
    queryFn: () =>
      apiFetch<AdminQuestionThreadContext>(`/v1/admin/questions/${threadId!}/context`),
  });
}

export function useAdminReplyToQuestion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { threadId: string; body: string }) =>
      apiFetch<AdminQuestionReplyResult>(`/v1/admin/questions/${args.threadId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ body: args.body }),
      }),
    onSuccess: (_data, args) => {
      void qc.invalidateQueries({ queryKey: ['admin', 'question', args.threadId] });
      void qc.invalidateQueries({ queryKey: ['admin', 'questions'] });
    },
  });
}

export function useUpdateAdminQuestion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { threadId: string; status: QuestionStatus }) =>
      apiFetch<AdminQuestionThreadDetail['thread']>(`/v1/admin/questions/${args.threadId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: args.status }),
      }),
    onSuccess: (_data, args) => {
      void qc.invalidateQueries({ queryKey: ['admin', 'question', args.threadId] });
      void qc.invalidateQueries({ queryKey: ['admin', 'questions'] });
    },
  });
}

/**
 * Archive or unarchive a whole thread. Archived threads vanish from every
 * consumer surface (the asker included); staff keep access. Circls can always
 * unarchive — including org archives.
 */
export function useArchiveAdminQuestion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { threadId: string; action: 'archive' | 'unarchive' }) =>
      apiFetch<AdminQuestionThreadDetail['thread']>(
        `/v1/admin/questions/${args.threadId}/${args.action}`,
        { method: 'POST' },
      ),
    onSuccess: (_data, args) => {
      void qc.invalidateQueries({ queryKey: ['admin', 'question', args.threadId] });
      void qc.invalidateQueries({ queryKey: ['admin', 'questions'] });
    },
  });
}

export function useHideQuestionMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { threadId: string; messageId: string }) =>
      apiFetch<QuestionMessageRow>(
        `/v1/admin/questions/${args.threadId}/messages/${args.messageId}/hide`,
        { method: 'POST' },
      ),
    onSuccess: (_data, args) => {
      void qc.invalidateQueries({ queryKey: ['admin', 'question', args.threadId] });
      void qc.invalidateQueries({ queryKey: ['admin', 'questions'] });
    },
  });
}

export function useUnhideQuestionMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { threadId: string; messageId: string }) =>
      apiFetch<QuestionMessageRow>(
        `/v1/admin/questions/${args.threadId}/messages/${args.messageId}/unhide`,
        { method: 'POST' },
      ),
    onSuccess: (_data, args) => {
      void qc.invalidateQueries({ queryKey: ['admin', 'question', args.threadId] });
      void qc.invalidateQueries({ queryKey: ['admin', 'questions'] });
    },
  });
}

// ── Coupons ───────────────────────────────────────────────────────────────────

export function useAdminCoupons() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['admin', 'coupons'],
    enabled: Boolean(user),
    queryFn: () => apiFetch<Coupon[]>('/v1/admin/coupons'),
  });
}

export function useAdminCouponStats() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['admin', 'coupon-stats'],
    enabled: Boolean(user),
    queryFn: () => apiFetch<AdminCouponStats>('/v1/admin/coupons/stats'),
  });
}

export interface AdminCreateCouponBody {
  code: string;
  description?: string;
  scopeType: 'org' | 'venue' | 'event' | 'arena' | 'membership';
  scopeId?: string;
  discountType: 'percent' | 'fixed';
  discountValue: number;
  maxDiscountPaise?: number;
  minOrderPaise?: number;
  visibility?: 'public' | 'private';
  validFrom?: string;
  validUntil?: string;
  maxRedemptions?: number;
  perUserLimit?: number;
}

export function useCreateAdminCoupon() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AdminCreateCouponBody) =>
      apiFetch<Coupon>('/v1/admin/coupons', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin', 'coupons'] }),
  });
}

/** Mirrors the API's PATCH body — everything editable after creation. */
export interface AdminUpdateCouponPatch {
  description?: string | null;
  minOrderPaise?: number | null;
  maxDiscountPaise?: number | null;
  visibility?: 'public' | 'private';
  validFrom?: string | null;
  validUntil?: string | null;
  maxRedemptions?: number | null;
  perUserLimit?: number | null;
  status?: 'active' | 'paused' | 'expired';
}

export function useUpdateAdminCoupon() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; patch: AdminUpdateCouponPatch }) =>
      apiFetch<Coupon>(`/v1/admin/coupons/${args.id}`, { method: 'PATCH', body: JSON.stringify(args.patch) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin', 'coupons'] }),
  });
}

export function useDeleteAdminCoupon() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/v1/admin/coupons/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin', 'coupons'] }),
  });
}
