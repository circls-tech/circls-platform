// ── Questions (customer support threads) hooks ────────────────────────────────
//
// Partner-side hooks for the questions inbox: consumers ask questions on the
// org's events, arenas and membership plans; the org answers from the portal.
// Capability enforcement (questions.read / questions.write) happens server-side
// — the UI surfaces API errors rather than pre-gating.

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';
import type {
  QuestionMessage,
  QuestionReplyResult,
  QuestionsSummary,
  QuestionStatus,
  QuestionSubjectType,
  QuestionThreadDetail,
  QuestionThreadsPage,
  QuestionVisibility,
} from './types';

export interface QuestionThreadsParams {
  status?: QuestionStatus;
  visibility?: QuestionVisibility;
  subjectType?: QuestionSubjectType;
  /** True selects the archived view; default (false) lists active threads. */
  archived?: boolean;
}

/** Org inbox: threads on the tenant's subjects, newest activity first. */
export function useQuestionThreads(tenantId: string, params: QuestionThreadsParams = {}) {
  return useInfiniteQuery({
    queryKey: [
      'questions',
      tenantId,
      params.status,
      params.visibility,
      params.subjectType,
      params.archived ?? false,
    ],
    enabled: Boolean(tenantId),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: QuestionThreadsPage) => last.nextCursor ?? undefined,
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams();
      if (params.status)      qs.set('status',      params.status);
      if (params.visibility)  qs.set('visibility',  params.visibility);
      if (params.subjectType) qs.set('subjectType', params.subjectType);
      if (params.archived)    qs.set('archived',    'true');
      if (pageParam)          qs.set('cursor',      pageParam);
      const query = qs.toString();
      return apiFetch<QuestionThreadsPage>(
        `/v1/tenants/${tenantId}/questions${query ? `?${query}` : ''}`,
      );
    },
  });
}

/** Open-thread count for the sidebar badge; polled so it stays fresh. */
export function useQuestionsSummary(tenantId: string | null) {
  return useQuery({
    queryKey: ['questions-summary', tenantId],
    enabled: Boolean(tenantId),
    refetchInterval: 60_000,
    queryFn: () => apiFetch<QuestionsSummary>(`/v1/tenants/${tenantId}/questions/summary`),
  });
}

export function useQuestionThread(tenantId: string, threadId: string) {
  return useQuery({
    queryKey: ['question', tenantId, threadId],
    enabled: Boolean(tenantId && threadId),
    queryFn: () =>
      apiFetch<QuestionThreadDetail>(`/v1/tenants/${tenantId}/questions/${threadId}`),
  });
}

function invalidateThread(
  qc: ReturnType<typeof useQueryClient>,
  tenantId: string,
  threadId: string,
) {
  void qc.invalidateQueries({ queryKey: ['question', tenantId, threadId] });
  void qc.invalidateQueries({ queryKey: ['questions', tenantId] });
  void qc.invalidateQueries({ queryKey: ['questions-summary', tenantId] });
}

/** Post an org reply. Replying to an `open` thread auto-marks it `answered`. */
export function useReplyToQuestion(tenantId: string, threadId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: string) =>
      apiFetch<QuestionReplyResult>(`/v1/tenants/${tenantId}/questions/${threadId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ body }),
      }),
    onSuccess: () => invalidateThread(qc, tenantId, threadId),
  });
}

/** Set the thread status explicitly (mark answered / close / reopen). */
export function useSetQuestionStatus(tenantId: string, threadId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (status: QuestionStatus) =>
      apiFetch<QuestionThreadDetail['thread']>(`/v1/tenants/${tenantId}/questions/${threadId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      }),
    onSuccess: () => invalidateThread(qc, tenantId, threadId),
  });
}

/**
 * Archive or unarchive the whole thread. Archived threads disappear from every
 * customer surface (the asker included); your team and Circls keep access via
 * the Archived tab. You can only unarchive threads your own team archived.
 */
export function useArchiveQuestionThread(tenantId: string, threadId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: 'archive' | 'unarchive') =>
      apiFetch<QuestionThreadDetail['thread']>(
        `/v1/tenants/${tenantId}/questions/${threadId}/${action}`,
        { method: 'POST' },
      ),
    onSuccess: () => invalidateThread(qc, tenantId, threadId),
  });
}

/** Hide or unhide a reply on a public thread (never the root question). */
export function useModerateQuestionMessage(tenantId: string, threadId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ messageId, action }: { messageId: string; action: 'hide' | 'unhide' }) =>
      apiFetch<QuestionMessage>(
        `/v1/tenants/${tenantId}/questions/${threadId}/messages/${messageId}/${action}`,
        { method: 'POST' },
      ),
    onSuccess: () => invalidateThread(qc, tenantId, threadId),
  });
}
