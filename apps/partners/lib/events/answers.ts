import type { EventQuestion } from '@/lib/api/types';

/**
 * Registration answers as the walk-in form holds them, keyed by question id:
 * a string for free-text and single-choice questions, the ticked options for a
 * multi-select question. Mirrors the consumer checkout's helpers (the apps
 * share no package), so keep the two in step.
 */
export type RegistrationAnswers = Record<string, string | string[]>;

/** One line of the registration call's `answers` field. */
export interface AnswerPayloadLine {
  questionId: string;
  answer: string | string[];
}

/** The string form of an answer for text inputs ('' when unanswered or multi-select). */
export function textAnswer(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : '';
}

/** Unanswered: no text, or no option ticked. */
export function isAnswerBlank(value: string | string[] | undefined): boolean {
  return Array.isArray(value) ? value.length === 0 : !(value ?? '').trim();
}

/** Tick or untick one option of a multi-select answer. */
export function toggleAnswerOption(
  answers: RegistrationAnswers,
  questionId: string,
  option: string,
  on: boolean,
): RegistrationAnswers {
  const current = answers[questionId];
  const chosen = new Set(Array.isArray(current) ? current : []);
  if (on) chosen.add(option);
  else chosen.delete(option);
  return { ...answers, [questionId]: [...chosen] };
}

/**
 * The `answers` field of the registration call: one entry per answered
 * question, in question order, trimmed. Unanswered questions are left out —
 * the API enforces the required ones.
 */
export function toAnswerPayload(
  questions: Pick<EventQuestion, 'id'>[],
  answers: RegistrationAnswers,
): AnswerPayloadLine[] {
  return questions.flatMap((q): AnswerPayloadLine[] => {
    const value = answers[q.id];
    if (Array.isArray(value)) {
      return value.length > 0 ? [{ questionId: q.id, answer: value }] : [];
    }
    const text = (value ?? '').trim();
    return text ? [{ questionId: q.id, answer: text }] : [];
  });
}
