import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { apiFetch } from './client';
import type {
  ActivityDailyCount,
  ActivityItemType,
  ActivityPage,
  MembershipWindows,
} from './types';

// ── Activity page hooks ───────────────────────────────────────────────────────

export interface ActivityFeedParams {
  type?: ActivityItemType | '';
  venueId?: string;
  from?: string; // ISO datetime, inclusive
  to?: string; // ISO datetime, exclusive
  q?: string;
  /** 'YYYY-MM-DD' — show sessions starting this day (calendar click-through). */
  sessionDate?: string;
  /** IANA tz `sessionDate` is interpreted in. */
  tz?: string;
}

export function useActivityFeed(tenantId: string, params: ActivityFeedParams = {}) {
  return useInfiniteQuery({
    queryKey: [
      'activity',
      tenantId,
      params.type,
      params.venueId,
      params.from,
      params.to,
      params.q,
      params.sessionDate,
      params.tz,
    ],
    enabled: Boolean(tenantId),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: ActivityPage) => last.nextCursor ?? undefined,
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams();
      if (params.type)    qs.set('type',    params.type);
      if (params.venueId) qs.set('venueId', params.venueId);
      if (params.from)    qs.set('from',    params.from);
      if (params.to)      qs.set('to',      params.to);
      if (params.q)       qs.set('q',       params.q);
      if (params.sessionDate) {
        qs.set('sessionDate', params.sessionDate);
        if (params.tz) qs.set('tz', params.tz);
      }
      if (pageParam)      qs.set('cursor',  pageParam);
      const query = qs.toString();
      return apiFetch<ActivityPage>(
        `/v1/tenants/${tenantId}/activity${query ? `?${query}` : ''}`,
      );
    },
  });
}

/** Per-day booking counts for one calendar month ('YYYY-MM') in `tz`. */
export function useActivityDaily(tenantId: string, month: string, tz: string, venueId?: string) {
  const qs = new URLSearchParams({ month, tz });
  if (venueId) qs.set('venueId', venueId);
  return useQuery({
    queryKey: ['activity-daily', tenantId, month, tz, venueId],
    queryFn: () =>
      apiFetch<ActivityDailyCount[]>(`/v1/tenants/${tenantId}/activity/daily?${qs.toString()}`),
    enabled: Boolean(tenantId && month),
  });
}

/** Memberships starting / ending around now (±window). */
export function useMembershipWindows(tenantId: string, withinDays = 30) {
  return useQuery({
    queryKey: ['activity-membership-windows', tenantId, withinDays],
    queryFn: () =>
      apiFetch<MembershipWindows>(
        `/v1/tenants/${tenantId}/activity/membership-windows?withinDays=${withinDays}`,
      ),
    enabled: Boolean(tenantId),
  });
}
