import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/lib/firebase/auth_context';
import { apiFetch } from './client';
import type { FeedbackPrompt, SubmitFeedbackInput, SubmittedFeedback } from './types';

/**
 * The feedback prompt the server wants to show this signed-in consumer (null
 * when there's nothing to ask). Drives the post-login FeedbackPromptProvider.
 */
export function useFeedbackPrompt() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['feedback-prompt', user?.uid],
    queryFn: () => apiFetch<{ prompt: FeedbackPrompt | null }>('/v1/consumer/feedback/prompt'),
    enabled: Boolean(user),
    select: (data) => data.prompt,
    // The prompt only changes when the user submits or books — don't refetch
    // on every focus while the modal may be open.
    staleTime: 5 * 60_000,
  });
}

/** Submit an event review or the event-type preference answer. */
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
