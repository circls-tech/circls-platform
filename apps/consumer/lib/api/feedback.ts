import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/lib/firebase/auth_context';
import { apiFetch } from './client';
import type { FeedbackPrompt, SubmitFeedbackInput, SubmittedFeedback } from './types';

/**
 * The feedback prompt the server wants to show this signed-in consumer (null
 * when there's nothing to ask). Drives the FeedbackPromptProvider.
 */
export function useFeedbackPrompt() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['feedback-prompt', user?.uid],
    queryFn: () => apiFetch<{ prompt: FeedbackPrompt | null }>('/v1/consumer/feedback/prompt'),
    enabled: Boolean(user),
    select: (data) => data.prompt,
    // The prompt only changes when the user answers, dismisses or books —
    // don't refetch on every focus while the modal may be open.
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}

/** Submit a rating, the event-type poll answer or the website survey. */
export function useSubmitFeedback() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SubmitFeedbackInput) =>
      apiFetch<{ feedback: SubmittedFeedback }>('/v1/consumer/feedback', {
        method: 'POST',
        body: JSON.stringify({ ...input, source: 'consumer' }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['feedback-prompt'] });
    },
  });
}

/**
 * "Not now": the server drops a rating or the poll for good and brings the
 * website survey back a week later, on any device.
 */
export function useDismissFeedback() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (key: string) =>
      apiFetch<{ ok: true }>('/v1/consumer/feedback/dismiss', {
        method: 'POST',
        body: JSON.stringify({ key }),
      }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['feedback-prompt'] });
    },
  });
}
