import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/lib/firebase/auth_context';
import { apiFetch } from './client';
import type {
  AdminAuditLogPage,
  AdminStats,
  AdminTenantDetail,
  AdminTenantListPage,
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
