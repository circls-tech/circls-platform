import { z } from 'zod';

/** Hard cap on questions per event (matches the tiers cap). */
export const MAX_EVENT_QUESTIONS = 20;
/** Most choices a single choice question may offer. */
export const MAX_QUESTION_OPTIONS = 20;
/** Longest option label. */
export const MAX_OPTION_LENGTH = 120;
/**
 * Longest free-text answer we store. A multi-select answer is the ticked
 * options joined together, so it may run a little longer than this.
 */
export const MAX_ANSWER_LENGTH = 2000;

/**
 * Shared request-body validator for registration-question answers, used by
 * the consumer booking call and the partner's off-platform registration.
 *
 * `answer` is a string for free-text and single-choice questions. A
 * multi-select question takes the chosen options as an array (a lone string
 * is accepted as one choice). Which shape a given question allows is checked
 * in saveRegistrationAnswers against the live question, not here.
 */
export const registrationAnswerSchema = z.object({
  questionId: z.string().uuid(),
  answer: z.union([
    z.string().max(MAX_ANSWER_LENGTH),
    // Each item must equal one of the question's options, so it is bounded
    // like an option, not like a free-text answer.
    z.array(z.string().max(MAX_OPTION_LENGTH)).max(MAX_QUESTION_OPTIONS),
  ]),
});

export const registrationAnswersField = z.array(registrationAnswerSchema).max(MAX_EVENT_QUESTIONS);
