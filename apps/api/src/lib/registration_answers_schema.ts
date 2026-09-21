import { z } from 'zod';
import { MAX_EVENT_QUESTIONS } from '../services/event_registration_questions_service.js';

/** Longest free-text answer we store. */
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
    z.array(z.string().max(MAX_ANSWER_LENGTH)).max(20),
  ]),
});

export const registrationAnswersField = z.array(registrationAnswerSchema).max(MAX_EVENT_QUESTIONS);
