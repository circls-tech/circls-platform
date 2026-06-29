/**
 * Data-driven Help chatbot flows (#115).
 *
 * The Help widget walks a deterministic decision tree of preset MCQ questions —
 * NOT an LLM and NOT live chat. The whole experience is described by the data
 * below, so adding or editing a flow means editing this config, never the
 * component. Each terminal node carries the support `category` the concern is
 * logged under (matching the backend enum in #114).
 *
 * Node kinds:
 *  - question      → a prompt + MCQ options; the chosen option names the next node.
 *  - booking_picker → the user picks one of their own bookings (booking-related
 *                     categories) before continuing; a "skip" is allowed.
 *  - free_text     → an optional free-text box, then continue.
 *  - terminal      → the concern is summarised + submitted under `category`.
 */

export const CONCERN_CATEGORIES = [
  'booking_issue',
  'refund_request',
  'reschedule',
  'venue_question',
  'payment',
  'other',
] as const;

export type ConcernCategory = (typeof CONCERN_CATEGORIES)[number];

export interface QuestionOption {
  label: string;
  /** id of the node this answer advances to */
  next: string;
}

export type FlowNode =
  | { id: string; kind: 'question'; prompt: string; options: QuestionOption[] }
  | { id: string; kind: 'booking_picker'; prompt: string; next: string }
  | { id: string; kind: 'free_text'; prompt: string; placeholder?: string; next: string }
  | { id: string; kind: 'terminal'; prompt: string; category: ConcernCategory };

export interface HelpFlow {
  rootId: string;
  nodes: Record<string, FlowNode>;
}

/** Categories whose flows route through a booking picker. */
export const BOOKING_RELATED: ReadonlySet<ConcernCategory> = new Set([
  'booking_issue',
  'refund_request',
  'reschedule',
  'payment',
]);

export const helpFlow: HelpFlow = {
  rootId: 'root',
  nodes: {
    root: {
      id: 'root',
      kind: 'question',
      prompt: 'Hi! What can we help you with today?',
      options: [
        { label: 'A problem with a booking', next: 'q_booking_kind' },
        { label: 'Refund or cancellation', next: 'q_refund_kind' },
        { label: 'Reschedule a booking', next: 'bp_reschedule' },
        { label: 'A question about a venue or event', next: 'q_venue_kind' },
        { label: 'A payment problem', next: 'q_payment_kind' },
        { label: 'Something else', next: 'ft_other' },
      ],
    },

    // ── Booking issue ────────────────────────────────────────────────────────
    q_booking_kind: {
      id: 'q_booking_kind',
      kind: 'question',
      prompt: 'What kind of booking problem?',
      options: [
        { label: 'Wrong booking details', next: 'bp_booking' },
        { label: 'I didn’t receive a confirmation', next: 'bp_booking' },
        { label: 'My booking failed / was not created', next: 'ft_booking_failed' },
      ],
    },
    bp_booking: {
      id: 'bp_booking',
      kind: 'booking_picker',
      prompt: 'Which booking is this about?',
      next: 'ft_booking',
    },
    ft_booking: {
      id: 'ft_booking',
      kind: 'free_text',
      prompt: 'Anything else we should know? (optional)',
      placeholder: 'Add any details that will help us…',
      next: 'term_booking',
    },
    ft_booking_failed: {
      id: 'ft_booking_failed',
      kind: 'free_text',
      prompt: 'Sorry about that. Tell us what happened (optional).',
      placeholder: 'What were you trying to book, and what went wrong?',
      next: 'term_booking',
    },
    term_booking: {
      id: 'term_booking',
      kind: 'terminal',
      prompt: 'Thanks — we’ll look into your booking issue.',
      category: 'booking_issue',
    },

    // ── Refund / cancellation ────────────────────────────────────────────────
    q_refund_kind: {
      id: 'q_refund_kind',
      kind: 'question',
      prompt: 'What would you like to do?',
      options: [
        { label: 'Request a refund', next: 'bp_refund' },
        { label: 'Cancel an upcoming booking', next: 'bp_refund' },
      ],
    },
    bp_refund: {
      id: 'bp_refund',
      kind: 'booking_picker',
      prompt: 'Which booking?',
      next: 'ft_refund',
    },
    ft_refund: {
      id: 'ft_refund',
      kind: 'free_text',
      prompt: 'Reason or any details (optional).',
      placeholder: 'e.g. can no longer attend',
      next: 'term_refund',
    },
    term_refund: {
      id: 'term_refund',
      kind: 'terminal',
      prompt: 'Thanks — we’ll review your refund/cancellation request.',
      category: 'refund_request',
    },

    // ── Reschedule ───────────────────────────────────────────────────────────
    bp_reschedule: {
      id: 'bp_reschedule',
      kind: 'booking_picker',
      prompt: 'Which booking would you like to reschedule?',
      next: 'ft_reschedule',
    },
    ft_reschedule: {
      id: 'ft_reschedule',
      kind: 'free_text',
      prompt: 'What new time works for you? (optional)',
      placeholder: 'e.g. any evening next week',
      next: 'term_reschedule',
    },
    term_reschedule: {
      id: 'term_reschedule',
      kind: 'terminal',
      prompt: 'Thanks — we’ll see what we can do about rescheduling.',
      category: 'reschedule',
    },

    // ── Venue / event question ───────────────────────────────────────────────
    q_venue_kind: {
      id: 'q_venue_kind',
      kind: 'question',
      prompt: 'What’s your question about?',
      options: [
        { label: 'Venue facilities or location', next: 'ft_venue' },
        { label: 'An event', next: 'ft_venue' },
        { label: 'Memberships', next: 'ft_venue' },
      ],
    },
    ft_venue: {
      id: 'ft_venue',
      kind: 'free_text',
      prompt: 'What would you like to know?',
      placeholder: 'Type your question…',
      next: 'term_venue',
    },
    term_venue: {
      id: 'term_venue',
      kind: 'terminal',
      prompt: 'Thanks — we’ll get back to you with an answer.',
      category: 'venue_question',
    },

    // ── Payment problem ──────────────────────────────────────────────────────
    q_payment_kind: {
      id: 'q_payment_kind',
      kind: 'question',
      prompt: 'What’s the payment issue?',
      options: [
        { label: 'I was charged but have no booking', next: 'bp_payment' },
        { label: 'My refund hasn’t arrived', next: 'bp_payment' },
        { label: 'Other payment issue', next: 'ft_payment' },
      ],
    },
    bp_payment: {
      id: 'bp_payment',
      kind: 'booking_picker',
      prompt: 'Which booking is this about? (optional — skip if none)',
      next: 'ft_payment',
    },
    ft_payment: {
      id: 'ft_payment',
      kind: 'free_text',
      prompt: 'Details (amount, date, anything that helps).',
      placeholder: 'e.g. ₹500 charged on 12 Jun, no booking shown',
      next: 'term_payment',
    },
    term_payment: {
      id: 'term_payment',
      kind: 'terminal',
      prompt: 'Thanks — we’ll investigate the payment.',
      category: 'payment',
    },

    // ── Something else ───────────────────────────────────────────────────────
    ft_other: {
      id: 'ft_other',
      kind: 'free_text',
      prompt: 'How can we help? Describe your question.',
      placeholder: 'Tell us what’s on your mind…',
      next: 'term_other',
    },
    term_other: {
      id: 'term_other',
      kind: 'terminal',
      prompt: 'Thanks — we’ve noted your enquiry.',
      category: 'other',
    },
  },
};
