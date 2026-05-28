import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';
import type { Membership, UserMembership } from './types';

export function useMemberships(tenantId: string) {
  return useQuery({
    queryKey: ['memberships', tenantId],
    queryFn: () => apiFetch<Membership[]>(`/v1/tenants/${tenantId}/memberships`),
    enabled: Boolean(tenantId),
  });
}

export interface CreateMembershipInput {
  venueId?: string;
  name: string;
  description?: string;
  pricePaise: number;
  durationDays: number;
  benefits?: Record<string, unknown>;
}

export function useCreateMembership(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateMembershipInput) =>
      apiFetch<Membership>(`/v1/tenants/${tenantId}/memberships`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['memberships', tenantId] }),
  });
}

export function useMyMemberships() {
  return useQuery({
    queryKey: ['my-memberships'],
    queryFn: () => apiFetch<UserMembership[]>('/v1/users/me/memberships'),
  });
}
