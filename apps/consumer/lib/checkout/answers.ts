import type { BookEventInput } from '@/lib/api/consumer';
import type { PublicEventQuestion } from '@/lib/api/types';

/**
 * Registration answers as the checkout holds them, keyed by question id: a
 * string for free-text and single-choice questions, the ticked options for a
 * multi-select question.
 */
export type RegistrationAnswers = Record<string, string | string[]>;

/** The booking call's `answers` field, as the API client declares it. */
type AnswerPayload = NonNullable<BookEventInput['answers']>;

/** True when the question has no usable answer yet. */
export function isAnswerBlank(value: string | string[] | undefined): boolean {
  return Array.isArray(value) ? value.length === 0 : !(value ?? '').trim();
}

/**
 * The `answers` field of the booking call: one entry per answered question, in
 * question order, trimmed. Unanswered questions are left out — the API enforces
 * the required ones against its live question list.
 */
export function toAnswerPayload(
  questions: PublicEventQuestion[],
  answers: RegistrationAnswers | null,
): AnswerPayload {
  return questions.flatMap((q): AnswerPayload => {
    const value = answers?.[q.id];
    if (Array.isArray(value)) {
      return value.length > 0 ? [{ questionId: q.id, answer: value }] : [];
    }
    const text = (value ?? '').trim();
    return text ? [{ questionId: q.id, answer: text }] : [];
  });
}
