import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/lib/firebase/auth_context';
import { apiFetch } from './client';
import type {
  AskQuestionInput,
  ListableQuestionSubjectType,
  QuestionReplyResult,
  QuestionStatus,
  QuestionThreadDetail,
  QuestionThreadListPage,
  SupportThreadInput,
} from './types';

// Small pages keep the detail-page section compact; "Show more" fetches the next.
const PAGE_SIZE = 10;

// ── Lists ─────────────────────────────────────────────────────────────────────

/** Public question threads for a subject — no auth required, works signed-out. */
export function usePublicQuestions(subjectType: ListableQuestionSubjectType, subjectId: string) {
  return useInfiniteQuery({
    queryKey: ['questions', subjectType, subjectId],
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: QuestionThreadListPage) => last.nextCursor ?? undefined,
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams({ subjectType, subjectId, limit: String(PAGE_SIZE) });
      if (pageParam) qs.set('cursor', pageParam);
      return apiFetch<QuestionThreadListPage>(`/v1/consumer/questions?${qs.toString()}`);
    },
    enabled: Boolean(subjectId),
  });
}

/**
 * The signed-in user's own threads (both visibilities), newest activity first.
 * Pass a subject to scope to one event/arena/membership (detail-page strip);
 * omit it for the full "/me/questions" list (rows then carry `subject` names).
 */
export function useMyQuestions(subject?: {
  subjectType: ListableQuestionSubjectType;
  subjectId: string;
}) {
  const { user } = useAuth();
  return useInfiniteQuery({
    queryKey: ['my-questions', user?.uid, subject?.subjectType ?? null, subject?.subjectId ?? null],
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: QuestionThreadListPage) => last.nextCursor ?? undefined,
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (subject) {
        qs.set('subjectType', subject.subjectType);
        qs.set('subjectId', subject.subjectId);
      }
      if (pageParam) qs.set('cursor', pageParam);
      return apiFetch<QuestionThreadListPage>(`/v1/consumer/questions/mine?${qs.toString()}`);
    },
    enabled: Boolean(user),
  });
}

// ── Thread detail ─────────────────────────────────────────────────────────────

/**
 * One thread with its full transcript. Auth is optional server-side, but the
 * Authorization header decides whether private threads resolve — so the query
 * waits for Firebase auth to settle and re-keys on the signed-in user.
 * Polls every 30s while mounted so replies show up without a manual refresh.
 */
export function useQuestionThread(threadId: string | null) {
  const { user, loading } = useAuth();
  return useQuery({
    queryKey: ['question-thread', user?.uid, threadId],
    queryFn: () => apiFetch<QuestionThreadDetail>(`/v1/consumer/questions/${threadId}`),
    enabled: Boolean(threadId) && !loading,
    refetchInterval: 30_000,
  });
}

// ── Mutations ─────────────────────────────────────────────────────────────────

/** Start a new thread. 429 `question_rate_limited` when the daily cap is hit. */
export function useAskQuestion() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: (input: AskQuestionInput) =>
      apiFetch<QuestionThreadDetail>('/v1/consumer/questions', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: (detail) => {
      // Seed the detail cache so opening the new thread is instant.
      qc.setQueryData(['question-thread', user?.uid, detail.thread.id], detail);
      void qc.invalidateQueries({
        queryKey: ['questions', detail.thread.subjectType, detail.thread.subjectId],
      });
      void qc.invalidateQueries({ queryKey: ['my-questions'] });
    },
  });
}

/**
 * Start a private support thread from the Help-widget interview (same endpoint,
 * `origin: 'support'` intake shape). The server derives the subject from the
 * picked booking — or `general` when none — and forces the thread private.
 * Errors: 404 `booking_not_found` (not yours / cancelled), 429
 * `question_rate_limited`.
 */
export function useSubmitSupportThread() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: (input: SupportThreadInput) =>
      apiFetch<QuestionThreadDetail>('/v1/consumer/questions', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: (detail) => {
      // Seed the detail cache so "View your conversation" opens instantly.
      qc.setQueryData(['question-thread', user?.uid, detail.thread.id], detail);
      // Support threads are always private — they never appear in public
      // subject lists, only in the caller's own thread lists.
      void qc.invalidateQueries({ queryKey: ['my-questions'] });
    },
  });
}

/** Reply on a thread. 409 `question_closed` / 429 `question_rate_limited`. */
export function useReplyToQuestion() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: ({ threadId, body }: { threadId: string; body: string }) =>
      apiFetch<QuestionReplyResult>(`/v1/consumer/questions/${threadId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ body }),
      }),
    onSuccess: (_result, { threadId }) => {
      void qc.invalidateQueries({ queryKey: ['question-thread', user?.uid, threadId] });
      void qc.invalidateQueries({ queryKey: ['questions'] });
      void qc.invalidateQueries({ queryKey: ['my-questions'] });
    },
  });
}

/** Author-only status change (mark answered / close). */
export function useSetQuestionStatus() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: ({ threadId, status }: { threadId: string; status: Exclude<QuestionStatus, 'open'> }) =>
      apiFetch<unknown>(`/v1/consumer/questions/${threadId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      }),
    onSuccess: (_result, { threadId }) => {
      void qc.invalidateQueries({ queryKey: ['question-thread', user?.uid, threadId] });
      void qc.invalidateQueries({ queryKey: ['questions'] });
      void qc.invalidateQueries({ queryKey: ['my-questions'] });
    },
  });
}
