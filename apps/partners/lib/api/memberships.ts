import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/lib/firebase/auth_context';
import { apiFetch } from './client';
import { VENUE_IMAGE_MAX_BYTES, VENUE_IMAGE_TYPES } from './queries';
import type {
  Membership,
  MembershipBenefits,
  MembershipPurchase,
  PresignedUpload,
  QrTicketConfig,
  UserMembership,
} from './types';

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

/** A plan-tier payload for membership create/update. `capacity: null` = unlimited. */
export interface MembershipTierInput {
  name: string;
  description?: string;
  pricePaise: number;
  durationDays: number;
  benefits?: MembershipBenefits;
  capacity: number | null;
  /** Per-tier QR override: null = inherit the plan-level config;
   *  `{ enabled: false }` = QR passes off for this tier; enabled = custom rules. */
  qrTicketConfig?: QrTicketConfig | null;
}

export interface CreateMembershipInput {
  venueId?: string;
  name: string;
  description?: string;
  terms?: string | null;
  /** Plan tiers (min 1). */
  tiers: MembershipTierInput[];
  /** QR ticket rules; null/omitted = disabled. */
  qrTicketConfig?: QrTicketConfig | null;
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
  terms?: string | null;
  /** Replace-all plan tiers (editable states only). */
  tiers?: MembershipTierInput[];
  /** QR ticket rules; null = disable. Omit to leave unchanged. */
  qrTicketConfig?: QrTicketConfig | null;
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

// ── Artwork (PR #110): single cover image, presign → PUT → finalize. ───────────

export function useUploadMembershipCover(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ membershipId, file }: { membershipId: string; file: File }): Promise<Membership> => {
      if (!VENUE_IMAGE_TYPES.includes(file.type)) throw new Error('Use a JPEG, PNG, or WebP image.');
      if (file.size > VENUE_IMAGE_MAX_BYTES) throw new Error('Image is too large (max 10 MB).');
      const presign = await apiFetch<PresignedUpload>(
        `/v1/tenants/${tenantId}/memberships/${membershipId}/cover/upload-presign`,
        { method: 'POST', body: JSON.stringify({ contentType: file.type }) },
      );
      const put = await fetch(presign.uploadUrl, { method: 'PUT', headers: presign.headers, body: file });
      if (!put.ok) throw new Error(`Upload to storage failed (${put.status}).`);
      return apiFetch<Membership>(`/v1/tenants/${tenantId}/memberships/${membershipId}/cover`, {
        method: 'POST',
        body: JSON.stringify({ storageKey: presign.storageKey }),
      });
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['memberships', tenantId] }),
  });
}

export function useRemoveMembershipCover(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (membershipId: string) =>
      apiFetch<Membership>(`/v1/tenants/${tenantId}/memberships/${membershipId}/cover`, {
        method: 'DELETE',
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['memberships', tenantId] }),
  });
}
