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

/** Booker details every registration already carries from the customer's account. */
export type CollectedField = 'name' | 'email' | 'phone';

/** How the nudge names each collected field ("…the booker's phone number"). */
const COLLECTED_FIELD_LABELS: Record<CollectedField, string> = {
  name: 'name',
  email: 'email address',
  phone: 'phone number',
};

/**
 * Normalised wordings (see alreadyCollectedField) that ask for nothing but a
 * collected field, in English, Hindi and Spanish. Bare "contact", "cell" and
 * "mail" are left out: on their own they are as likely to mean something else.
 */
const COLLECTED_FIELD_PATTERNS: [CollectedField, RegExp][] = [
  ['name', /^(?:(?:full|first|last|first and last) name|name|surname|(?:पूरा )?नाम|nombre(?: completo)?)$/u],
  ['email', /^(?:e ?mail(?: address| id)?|mail id|ई ?मेल(?: आईडी| पता)?|correo(?: electronico)?)$/u],
  [
    'phone',
    /^(?:(?:(?:mobile|cell) )?phone(?: number| no| num)?|(?:mobile|cell|contact|telephone|mob|ph) (?:number|no|num)|mobile|telephone|(?:फ़?ोन|मोबाइल)(?: नंबर)?|(?:numero de )?telefono|celular)$/u,
  ],
];

/**
 * The collected field a question asks for, or null. Only questions asking for
 * the booker's own name, email or phone and nothing else match ("What's your
 * phone number?", "Email ID", "आपका नाम"), so "Team name" or "Emergency
 * contact number" never trip it. The editor uses it to nudge, never to block.
 */
export function alreadyCollectedField(label: string): CollectedField | null {
  const core = label
    .normalize('NFD')
    // Latin accents only ("teléfono" → "telefono"); Devanagari vowel signs are marks too and must stay.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim()
    .replace(/ (?:please|क्या है)$/u, '')
    .replace(
      /^(?:please )?(?:(?:enter|provide|share|give)(?: us)? )?(?:(?:what is|what s|whats) )?(?:your |आपका |अपना )?/u,
      '',
    );
  return COLLECTED_FIELD_PATTERNS.find(([, pattern]) => pattern.test(core))?.[0] ?? null;
}

/** The editor's note under a question asking for a collected field, or null. */
export function collectedFieldNudge(label: string): string | null {
  const field = alreadyCollectedField(label);
  return field && `You already get the booker's ${COLLECTED_FIELD_LABELS[field]} with every registration.`;
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
