/**
 * Pure, data-driven flow engine for the Help chatbot (#115). No React, no
 * network — just immutable state transitions over a {@link HelpFlow} graph, so
 * the traversal/branching/terminal logic is unit-testable in isolation.
 */
import type { ConcernCategory, FlowNode, HelpFlow } from './flows.js';

/** One answered step of the walked flow: the question shown and the answer given. */
export interface AnswerEntry {
  question: string;
  answer: string;
}

/** A picked booking (id + a human label for the transcript). */
export interface PickedBooking {
  id: string;
  label: string;
}

/** Immutable snapshot of where the user is in the flow + what they've answered. */
export interface FlowState {
  currentId: string;
  transcript: AnswerEntry[];
  bookingId: string | null;
  bookingLabel: string | null;
  freeText: string;
}

/**
 * The support-intake payload posted to POST /v1/consumer/questions. Creates a
 * private question thread (server derives subject/tenant from the booking, or
 * `general` when none). Structurally matches `SupportThreadInput` in
 * `lib/api/types.ts`.
 */
export interface SupportSubmission {
  origin: 'support';
  category: ConcernCategory;
  /** 1–2000 chars — the thread's root message. */
  body: string;
  bookingId?: string;
  /** ≤50 entries, question/answer 1–500 chars each. */
  flowAnswers?: AnswerEntry[];
}

/** Resolve a node by id, throwing on an unknown id (a malformed flow is a bug). */
export function getNode(flow: HelpFlow, id: string): FlowNode {
  const node = flow.nodes[id];
  if (!node) throw new Error(`Unknown flow node: ${id}`);
  return node;
}

/** Fresh state positioned at the flow root. */
export function startFlow(flow: HelpFlow): FlowState {
  // Root must exist; getNode throws otherwise.
  getNode(flow, flow.rootId);
  return { currentId: flow.rootId, transcript: [], bookingId: null, bookingLabel: null, freeText: '' };
}

/** The node the user is currently on. */
export function currentNode(flow: HelpFlow, state: FlowState): FlowNode {
  return getNode(flow, state.currentId);
}

/** Whether the flow has reached a terminal (submit) node. */
export function isTerminal(flow: HelpFlow, state: FlowState): boolean {
  return currentNode(flow, state).kind === 'terminal';
}

/** Pick option `index` of the current question node and advance. */
export function chooseOption(flow: HelpFlow, state: FlowState, index: number): FlowState {
  const node = currentNode(flow, state);
  if (node.kind !== 'question') {
    throw new Error(`chooseOption called on a ${node.kind} node`);
  }
  const option = node.options[index];
  if (!option) throw new Error(`Option ${index} out of range on ${node.id}`);
  return {
    ...state,
    currentId: option.next,
    transcript: [...state.transcript, { question: node.prompt, answer: option.label }],
  };
}

/**
 * Resolve the current booking-picker node with a chosen booking (or null to
 * skip), recording it in the transcript and advancing.
 */
export function chooseBooking(
  flow: HelpFlow,
  state: FlowState,
  booking: PickedBooking | null,
): FlowState {
  const node = currentNode(flow, state);
  if (node.kind !== 'booking_picker') {
    throw new Error(`chooseBooking called on a ${node.kind} node`);
  }
  const answer = booking ? booking.label : 'No specific booking';
  return {
    ...state,
    currentId: node.next,
    bookingId: booking?.id ?? null,
    bookingLabel: booking?.label ?? null,
    transcript: [...state.transcript, { question: node.prompt, answer }],
  };
}

/** Submit the (optional) free text for the current free_text node and advance. */
export function submitFreeText(flow: HelpFlow, state: FlowState, text: string): FlowState {
  const node = currentNode(flow, state);
  if (node.kind !== 'free_text') {
    throw new Error(`submitFreeText called on a ${node.kind} node`);
  }
  const trimmed = text.trim();
  return {
    ...state,
    currentId: node.next,
    freeText: trimmed,
    transcript: [
      ...state.transcript,
      { question: node.prompt, answer: trimmed || '(no additional details)' },
    ],
  };
}

/** The category of the terminal node (throws if not yet terminal). */
export function terminalCategory(flow: HelpFlow, state: FlowState): ConcernCategory {
  const node = currentNode(flow, state);
  if (node.kind !== 'terminal') throw new Error('Flow is not at a terminal node');
  return node.category;
}

// POST /v1/consumer/questions support-intake limits (apps/api questions route).
const MAX_BODY = 2000;
const MAX_FLOW_ANSWERS = 50;
const MAX_FLOW_FIELD = 500;

/** Trim + clamp a flowAnswers field to the API's 500-char limit. */
function clampField(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > MAX_FLOW_FIELD ? trimmed.slice(0, MAX_FLOW_FIELD) : trimmed;
}

/**
 * Build the support-intake payload from a terminal state: the interview's
 * category, the user's free text as the thread's root message (falling back to
 * a digest of the MCQ path when none was given), the structured MCQ path as
 * `flowAnswers`, and the picked booking (if any). All fields are trimmed and
 * clamped to the API limits.
 */
export function buildSubmission(flow: HelpFlow, state: FlowState): SupportSubmission {
  const node = currentNode(flow, state);
  if (node.kind !== 'terminal') throw new Error('Cannot submit before reaching a terminal node');

  // The user's own words become the root message; when the interview collected
  // none, digest the MCQ path so the message is never empty.
  let body = state.freeText.trim();
  if (body.length === 0) {
    body = `Support request — ${state.transcript.map((t) => t.answer).join(' → ')}`;
  }
  if (body.length > MAX_BODY) body = body.slice(0, MAX_BODY);

  const flowAnswers = state.transcript
    .slice(0, MAX_FLOW_ANSWERS)
    .map((t) => ({ question: clampField(t.question), answer: clampField(t.answer) }))
    .filter((t) => t.question.length > 0 && t.answer.length > 0);

  const submission: SupportSubmission = {
    origin: 'support',
    category: node.category,
    body,
  };
  if (flowAnswers.length > 0) submission.flowAnswers = flowAnswers;
  if (state.bookingId) submission.bookingId = state.bookingId;
  return submission;
}
