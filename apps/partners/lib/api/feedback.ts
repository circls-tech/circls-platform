// ── Platform feedback survey hooks ────────────────────────────────────────────
//
// The partner side of the feedback prompts: once per organisation, Owners and
// Managers are asked how easy the portal is (creating events, venues and
// membership plans, challenges, overall ease, other comments). The server
// decides whether to ask — null for Staff, Read-only, a Circls super admin, an
// org that has answered, or someone who said "Not now" in the last week.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/lib/firebase/auth_context';
import { apiFetch } from './client';

export interface PartnerFeedbackPrompt {
  kind: 'partner_site_feedback';
  key: string;
  /** Listing types the org has created; the others start on "Haven't tried". */
  tried: { events: boolean; venues: boolean; memberships: boolean };
}

/** Body of POST /v1/tenants/:id/feedback; area ratings are null for "Haven't tried". */
export interface PartnerFeedbackInput {
  overallRating: number;
  eventCreationRating: number | null;
  venueCreationRating: number | null;
  membershipCreationRating: number | null;
  challenges?: string;
  comments?: string;
}

export function usePartnerFeedbackPrompt(tenantId: string | null) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['partner-feedback-prompt', tenantId, user?.uid],
    enabled: Boolean(user && tenantId),
    queryFn: () =>
      apiFetch<{ prompt: PartnerFeedbackPrompt | null }>(`/v1/tenants/${tenantId}/feedback/prompt`),
    select: (data) => data.prompt,
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: false,
  });
}

export function useSubmitPartnerFeedback(tenantId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: PartnerFeedbackInput) =>
      apiFetch<{ feedback: { id: string } }>(`/v1/tenants/${tenantId}/feedback`, {
        method: 'POST',
        body: JSON.stringify({ ...input, source: 'partners' }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['partner-feedback-prompt', tenantId] });
    },
  });
}

/** "Not now": asked again in a week (just this person; the org stays unanswered). */
export function useDismissPartnerFeedback(tenantId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ ok: true }>(`/v1/tenants/${tenantId}/feedback/dismiss`, { method: 'POST', body: '{}' }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['partner-feedback-prompt', tenantId] });
    },
  });
}
