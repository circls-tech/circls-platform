import type { EventQuestionInput } from '@/lib/api/events';
import type { EventQuestion } from '@/lib/api/types';

/** Cap on questions per event — keep in sync with the API's MAX_EVENT_QUESTIONS. */
export const MAX_EVENT_QUESTIONS = 20;

export type QuestionType = EventQuestion['type'];

/** Form-draft shape: choice options are edited as one comma-separated string. */
export interface QuestionDraft {
  label: string;
  type: QuestionType;
  required: boolean;
  /** Comma-separated choices; only meaningful for choice questions. */
  optionsText: string;
}

/** Partner-facing name of each answer type (editor dropdown + summaries). */
export const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  text: 'Free text',
  select: 'Single choice (pick one)',
  multiselect: 'Multiple choice (pick any)',
};

/** Attendee details every registration already carries from the customer's account. */
export type CollectedField = 'name' | 'email' | 'phone';

/** How the editor names each collected field ("…each attendee's phone number"). */
export const COLLECTED_FIELD_LABELS: Record<CollectedField, string> = {
  name: 'name',
  email: 'email address',
  phone: 'phone number',
};

/** Normalised question wordings that ask for nothing but a collected field. */
const COLLECTED_FIELD_QUESTIONS: Record<string, CollectedField> = {
  name: 'name',
  'full name': 'name',
  'first name': 'name',
  'last name': 'name',
  surname: 'name',
  'first and last name': 'name',
  email: 'email',
  'e mail': 'email',
  'email address': 'email',
  'e mail address': 'email',
  'email id': 'email',
  'e mail id': 'email',
  'mail id': 'email',
  phone: 'phone',
  'phone number': 'phone',
  'phone no': 'phone',
  'ph no': 'phone',
  mobile: 'phone',
  'mobile number': 'phone',
  'mobile no': 'phone',
  'contact number': 'phone',
  'contact no': 'phone',
  'cell number': 'phone',
  telephone: 'phone',
  'telephone number': 'phone',
};

/**
 * The collected field a question asks for, or null. Only questions asking for
 * the attendee's own name, email or phone and nothing else match ("What's your
 * phone number?", "Email ID"), so "Team name" or "Emergency contact number"
 * never trip it. The editor uses it to nudge, never to block.
 */
export function alreadyCollectedField(label: string): CollectedField | null {
  const core = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^(?:please )?(?:(?:enter|provide|share|give)(?: us)? )?(?:(?:what is|what s|whats) )?(?:your )?/, '');
  return COLLECTED_FIELD_QUESTIONS[core] ?? null;
}

/** Choice questions ('select' = pick one, 'multiselect' = pick any) carry options. */
export function isChoiceType(type: QuestionType): boolean {
  return type === 'select' || type === 'multiselect';
}

export function emptyQuestion(): QuestionDraft {
  return { label: '', type: 'text', required: false, optionsText: '' };
}

/** The choices typed into a draft: trimmed, blanks and repeats dropped. */
export function draftOptions(q: Pick<QuestionDraft, 'optionsText'>): string[] {
  return [
    ...new Set(
      q.optionsText
        .split(',')
        .map((o) => o.trim())
        .filter((o) => o.length > 0),
    ),
  ];
}

/** Convert drafts to the API payload shape, dropping rows with a blank label. */
export function questionsToPayload(questions: QuestionDraft[]): EventQuestionInput[] {
  return questions
    .map((q) => ({
      label: q.label.trim(),
      type: q.type,
      required: q.required,
      ...(isChoiceType(q.type) ? { options: draftOptions(q) } : {}),
    }))
    .filter((q) => q.label.length > 0);
}

/** Hydrate a draft from an event's question (as returned by GET event). */
export function questionDraftFromApi(
  q: Pick<EventQuestion, 'label' | 'type' | 'required' | 'options'>,
): QuestionDraft {
  return {
    label: q.label,
    type: q.type,
    required: q.required,
    optionsText: (q.options ?? []).join(', '),
  };
}

/**
 * True when a labelled choice question has fewer than 2 options. The API
 * rejects such a question, so forms check this before submitting and show a
 * friendlier message.
 */
export function hasChoiceQuestionWithoutOptions(questions: QuestionDraft[]): boolean {
  return questions.some(
    (q) => q.label.trim().length > 0 && isChoiceType(q.type) && draftOptions(q).length < 2,
  );
}
