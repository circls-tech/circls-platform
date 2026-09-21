/**
 * Registration-question service. Questions belong to an event; consumers answer
 * them at booking time (answers live in event_registration_answers, one row per
 * question per booking). Writes are replace-all, valid while the event is draft
 * or published (a live edit soft-deletes and reinserts; existing answers keep
 * their original question_id + snapshotted label). Write helpers take a
 * transaction handle so they compose inside the event create/update tx and the
 * booking tx.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  eventRegistrationQuestions,
  type EventRegistrationQuestion,
  type RegistrationQuestionType,
} from '../db/schema/event_registration_questions.js';
import { eventRegistrationAnswers } from '../db/schema/event_registration_answers.js';
import { BadRequest } from '../lib/errors.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Database = typeof db | Tx;

/** Hard cap on questions per event (matches the tiers cap). */
export const MAX_EVENT_QUESTIONS = 20;

export interface RegistrationQuestionInput {
  label: string;
  type: RegistrationQuestionType;
  required: boolean;
  /** Choices for 'select' / 'multiselect' questions; ignored for free-text. */
  options?: string[] | null | undefined;
}

/**
 * One answer as submitted by the consumer booking flow (or the partner's
 * off-platform registration). Free-text and single-choice questions take a
 * string; a multi-select question takes the chosen options as an array (a
 * lone string counts as one choice).
 */
export interface RegistrationAnswerInput {
  questionId: string;
  answer: string | string[];
}

/** Choice questions carry `options`; free-text questions don't. */
export function isChoiceQuestionType(type: RegistrationQuestionType): boolean {
  return type === 'select' || type === 'multiselect';
}

/**
 * How a multi-select answer is stored: the chosen options, in the question's
 * option order, joined with this. Answers stay one text value per question so
 * the registrations table, the CSV export and the booking page render them
 * as-is.
 */
export const MULTI_ANSWER_SEPARATOR = ', ';

/** Live (non-deleted) questions for an event, ordered for display. */
export async function listQuestions(
  database: Database,
  eventId: string,
): Promise<EventRegistrationQuestion[]> {
  return database
    .select()
    .from(eventRegistrationQuestions)
    .where(
      and(
        eq(eventRegistrationQuestions.eventId, eventId),
        isNull(eventRegistrationQuestions.deletedAt),
      ),
    )
    .orderBy(eventRegistrationQuestions.sortOrder, eventRegistrationQuestions.createdAt);
}

/**
 * Replace an event's registration questions. Soft-deletes questions no longer
 * present and inserts the provided set fresh. Safe on live events too: existing
 * answers keep referencing their (soft-deleted) question with a snapshotted
 * label, and in-flight consumers submitting a stale question id get a clear
 * error. An empty set is valid (most events ask nothing extra).
 */
export async function replaceQuestions(
  tx: Tx,
  eventId: string,
  tenantId: string,
  questions: RegistrationQuestionInput[],
): Promise<EventRegistrationQuestion[]> {
  if (questions.length > MAX_EVENT_QUESTIONS) {
    throw new BadRequest(
      `An event can have at most ${MAX_EVENT_QUESTIONS} registration questions`,
      'event_questions_limit',
    );
  }
  await tx
    .update(eventRegistrationQuestions)
    .set({ deletedAt: sql`now()` })
    .where(
      and(
        eq(eventRegistrationQuestions.eventId, eventId),
        isNull(eventRegistrationQuestions.deletedAt),
      ),
    );

  if (questions.length === 0) return [];

  return tx
    .insert(eventRegistrationQuestions)
    .values(
      questions.map((q, i) => ({
        eventId,
        tenantId,
        label: q.label,
        type: q.type,
        required: q.required,
        options: isChoiceQuestionType(q.type) ? (q.options ?? []) : null,
        sortOrder: i,
      })),
    )
    .returning();
}

/**
 * Validate a consumer's answers against the event's live questions and insert
 * them for the booking, inside the booking transaction. Rejects unknown
 * question ids, missing/blank answers to required questions, choice answers
 * that aren't one of the question's options, and a list of answers to a
 * question that takes one. Answers to questions the event doesn't (any longer)
 * ask are rejected rather than silently dropped so the client learns its
 * question list is stale. Multi-select answers are stored as one text value
 * (see normaliseAnswer).
 */
export async function saveRegistrationAnswers(
  tx: Tx,
  eventId: string,
  bookingId: string,
  answers: RegistrationAnswerInput[],
): Promise<void> {
  const questions = await listQuestions(tx, eventId);
  if (questions.length === 0 && answers.length === 0) return;

  const byId = new Map(questions.map((q) => [q.id, q]));
  const answerByQuestion = new Map<string, string>();
  for (const a of answers) {
    const q = byId.get(a.questionId);
    if (!q) throw new BadRequest('Unknown registration question for this event', 'bad_request');
    if (answerByQuestion.has(a.questionId)) {
      throw new BadRequest('Duplicate answer for a registration question', 'bad_request');
    }
    answerByQuestion.set(a.questionId, normaliseAnswer(q, a.answer));
  }

  for (const q of questions) {
    if (q.required && !answerByQuestion.get(q.id)) {
      throw new BadRequest(`"${q.label}" requires an answer`, 'answer_required', {
        questionId: q.id,
      });
    }
  }

  const values = questions
    .filter((q) => (answerByQuestion.get(q.id) ?? '') !== '')
    .map((q) => ({
      bookingId,
      questionId: q.id,
      questionLabel: q.label,
      answer: answerByQuestion.get(q.id)!,
    }));
  if (values.length > 0) {
    await tx.insert(eventRegistrationAnswers).values(values);
  }
}

/**
 * Reduce a submitted answer to the single text value we store, enforcing the
 * question's shape: free text is trimmed; a single choice must be one of the
 * options; a multi-select takes any subset of the options, stored
 * deduplicated in option order. '' means "not answered", which the required
 * check in saveRegistrationAnswers then rejects.
 */
function normaliseAnswer(q: EventRegistrationQuestion, raw: string | string[]): string {
  const options = [...new Set(q.options ?? [])];
  const notAnOption = () =>
    new BadRequest(`Answer to "${q.label}" must be one of its options`, 'invalid_answer_option', {
      questionId: q.id,
    });
  if (q.type === 'multiselect') {
    const chosen = new Set(
      (Array.isArray(raw) ? raw : [raw]).map((s) => s.trim()).filter((s) => s.length > 0),
    );
    for (const c of chosen) {
      if (!options.includes(c)) throw notAnOption();
    }
    return options.filter((o) => chosen.has(o)).join(MULTI_ANSWER_SEPARATOR);
  }
  if (Array.isArray(raw)) {
    throw new BadRequest(`"${q.label}" takes a single answer`, 'bad_request', {
      questionId: q.id,
    });
  }
  const answer = raw.trim();
  if (q.type === 'select' && answer && !options.includes(answer)) throw notAnOption();
  return answer;
}
