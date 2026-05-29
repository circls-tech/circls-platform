import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/lib/firebase/auth_context';
import { apiFetch } from './client';
import type { Membership, MembershipPurchase, UserMembership } from './types';

export function useMemberships(tenantId: string) {
  return useQuery({
    queryKey: ['memberships', tenantId],
    queryFn: () => apiFetch<Membership[]>(`/v1/tenants/${tenantId}/memberships`),
    enabled: Boolean(tenantId),
  });
}

/** Consumer purchases of a membership plan (partner-facing). */
export function useMembershipPurchases(tenantId: string, membershipId: string) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['membership-purchases', tenantId, membershipId],
    queryFn: () =>
      apiFetch<{ rows: MembershipPurchase[] }>(
        `/v1/tenants/${tenantId}/memberships/${membershipId}/purchases`,
      ),
    enabled: Boolean(user) && Boolean(tenantId) && Boolean(membershipId),
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

export interface UpdateMembershipInput {
  /** Nullable: pass null to make the plan org-wide. */
  venueId?: string | null;
  name?: string;
  description?: string;
  pricePaise?: number;
  durationDays?: number;
  benefits?: Record<string, unknown>;
}

/**
 * PATCH a membership. Editable only when pending_review or inactive — the API
 * returns 409 membership_not_editable otherwise.
 */
export function useUpdateMembership(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateMembershipInput }) =>
      apiFetch<Membership>(`/v1/tenants/${tenantId}/memberships/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['memberships', tenantId] }),
  });
}

/** Activate a membership (inactive → active). */
export function useActivateMembership(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<Membership>(`/v1/tenants/${tenantId}/memberships/${id}/activate`, {
        method: 'POST',
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['memberships', tenantId] }),
  });
}

/** Deactivate a membership (active → inactive). */
export function useDeactivateMembership(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<Membership>(`/v1/tenants/${tenantId}/memberships/${id}/deactivate`, {
        method: 'POST',
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
