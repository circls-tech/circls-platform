import { describe, expect, it } from 'vitest';
import {
  BOOKING_RELATED,
  CONCERN_CATEGORIES,
  helpFlow,
  type ConcernCategory,
  type HelpFlow,
} from './flows';
import {
  buildSubmission,
  chooseBooking,
  chooseOption,
  currentNode,
  getNode,
  isTerminal,
  startFlow,
  submitFreeText,
  terminalCategory,
  type FlowState,
} from './engine';

/** Drive a question node by the label of the option to pick. */
function pickLabel(flow: HelpFlow, state: FlowState, label: string): FlowState {
  const node = currentNode(flow, state);
  if (node.kind !== 'question') throw new Error('not a question node');
  const idx = node.options.findIndex((o) => o.label === label);
  expect(idx).toBeGreaterThanOrEqual(0);
  return chooseOption(flow, state, idx);
}

describe('help flow engine', () => {
  it('starts at the root question', () => {
    const s = startFlow(helpFlow);
    expect(s.currentId).toBe(helpFlow.rootId);
    expect(s.transcript).toEqual([]);
    expect(isTerminal(helpFlow, s)).toBe(false);
    expect(currentNode(helpFlow, s).kind).toBe('question');
  });

  it('records each answer in the transcript as it traverses', () => {
    let s = startFlow(helpFlow);
    s = pickLabel(helpFlow, s, 'Something else');
    expect(s.transcript).toEqual([
      { question: 'Hi! What can we help you with today?', answer: 'Something else' },
    ]);
    expect(currentNode(helpFlow, s).kind).toBe('free_text');
  });

  it('branches: different root answers reach different categories', () => {
    // "Something else" → other
    let other = startFlow(helpFlow);
    other = pickLabel(helpFlow, other, 'Something else');
    other = submitFreeText(helpFlow, other, 'just curious');
    expect(isTerminal(helpFlow, other)).toBe(true);
    expect(terminalCategory(helpFlow, other)).toBe('other');

    // "A question about a venue or event" → venue_question
    let venue = startFlow(helpFlow);
    venue = pickLabel(helpFlow, venue, 'A question about a venue or event');
    venue = pickLabel(helpFlow, venue, 'An event');
    venue = submitFreeText(helpFlow, venue, 'when does it start?');
    expect(terminalCategory(helpFlow, venue)).toBe('venue_question');
  });

  it('branches within a sub-flow: booking "failed" skips the booking picker', () => {
    let s = startFlow(helpFlow);
    s = pickLabel(helpFlow, s, 'A problem with a booking');
    s = pickLabel(helpFlow, s, 'My booking failed / was not created');
    // Goes straight to free_text (no booking picker), unlike the other options.
    expect(currentNode(helpFlow, s).kind).toBe('free_text');
    s = submitFreeText(helpFlow, s, 'card declined twice');
    expect(terminalCategory(helpFlow, s)).toBe('booking_issue');
    expect(s.bookingId).toBeNull();
  });

  it('walks a booking-related flow through the picker and attaches the booking', () => {
    let s = startFlow(helpFlow);
    s = pickLabel(helpFlow, s, 'Reschedule a booking');
    expect(currentNode(helpFlow, s).kind).toBe('booking_picker');
    s = chooseBooking(helpFlow, s, { id: 'bk-123', label: 'Tennis @ Smash Arena' });
    expect(s.bookingId).toBe('bk-123');
    expect(currentNode(helpFlow, s).kind).toBe('free_text');
    s = submitFreeText(helpFlow, s, 'prefer next weekend');

    const sub = buildSubmission(helpFlow, s);
    expect(sub.category).toBe('reschedule');
    expect(sub.bookingId).toBe('bk-123');
    expect(sub.flowAnswers).toEqual([
      { question: 'Hi! What can we help you with today?', answer: 'Reschedule a booking' },
      { question: 'Which booking would you like to reschedule?', answer: 'Tennis @ Smash Arena' },
      { question: 'What new time works for you? (optional)', answer: 'prefer next weekend' },
    ]);
    expect(sub.message).toContain('reschedule');
    expect(sub.message).toContain('Tennis @ Smash Arena');
  });

  it('allows skipping the booking picker (no booking attached)', () => {
    let s = startFlow(helpFlow);
    s = pickLabel(helpFlow, s, 'A payment problem');
    s = pickLabel(helpFlow, s, 'I was charged but have no booking');
    expect(currentNode(helpFlow, s).kind).toBe('booking_picker');
    s = chooseBooking(helpFlow, s, null);
    expect(s.bookingId).toBeNull();
    s = submitFreeText(helpFlow, s, '₹500 charged, no booking');
    const sub = buildSubmission(helpFlow, s);
    expect(sub.category).toBe('payment');
    expect(sub.bookingId).toBeUndefined();
    expect(sub.flowAnswers.some((a) => a.answer === 'No specific booking')).toBe(true);
  });

  it('empty free text is recorded as a placeholder answer', () => {
    let s = startFlow(helpFlow);
    s = pickLabel(helpFlow, s, 'Something else');
    s = submitFreeText(helpFlow, s, '   ');
    expect(s.freeText).toBe('');
    expect(s.transcript.at(-1)?.answer).toBe('(no additional details)');
  });

  it('throws when an action is used on the wrong node kind', () => {
    const s = startFlow(helpFlow); // root is a question
    expect(() => chooseBooking(helpFlow, s, null)).toThrow();
    expect(() => submitFreeText(helpFlow, s, 'x')).toThrow();
    expect(() => buildSubmission(helpFlow, s)).toThrow();
    expect(() => terminalCategory(helpFlow, s)).toThrow();
  });

  it('throws on an out-of-range option', () => {
    const s = startFlow(helpFlow);
    expect(() => chooseOption(helpFlow, s, 99)).toThrow();
  });

  it('getNode throws on an unknown id', () => {
    expect(() => getNode(helpFlow, 'does_not_exist')).toThrow();
  });

  it('transitions are immutable (does not mutate prior state)', () => {
    const s0 = startFlow(helpFlow);
    const s1 = pickLabel(helpFlow, s0, 'Something else');
    expect(s0.transcript).toEqual([]);
    expect(s1).not.toBe(s0);
  });
});

describe('help flow integrity', () => {
  it('every option/next target points to a real node', () => {
    for (const node of Object.values(helpFlow.nodes)) {
      if (node.kind === 'question') {
        for (const opt of node.options) expect(helpFlow.nodes[opt.next], opt.next).toBeTruthy();
      } else if (node.kind === 'booking_picker' || node.kind === 'free_text') {
        expect(helpFlow.nodes[node.next], node.next).toBeTruthy();
      }
    }
  });

  it('every terminal category is a known concern category', () => {
    const known = new Set<string>(CONCERN_CATEGORIES);
    for (const node of Object.values(helpFlow.nodes)) {
      if (node.kind === 'terminal') expect(known.has(node.category)).toBe(true);
    }
  });

  it('every reachable terminal is reachable from the root, and reaches a terminal', () => {
    // BFS from root; assert we hit at least one terminal and never dangle.
    const seen = new Set<string>();
    const queue = [helpFlow.rootId];
    let terminals = 0;
    while (queue.length) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const node = getNode(helpFlow, id);
      if (node.kind === 'terminal') terminals++;
      else if (node.kind === 'question') node.options.forEach((o) => queue.push(o.next));
      else queue.push(node.next);
    }
    expect(terminals).toBeGreaterThan(0);
  });

  it('booking-related categories actually route through a booking picker', () => {
    // For each terminal whose category is booking-related, at least one path to
    // it includes a booking_picker. We verify the seeded flows: reschedule,
    // refund_request, booking_issue (via the non-failed options), payment.
    const categoriesWithPicker = new Set<ConcernCategory>();
    for (const node of Object.values(helpFlow.nodes)) {
      if (node.kind !== 'booking_picker') continue;
      // The picker's downstream terminal category.
      let cur = getNode(helpFlow, node.next);
      while (cur.kind !== 'terminal') {
        cur = getNode(helpFlow, cur.kind === 'question' ? cur.options[0]!.next : cur.next);
      }
      categoriesWithPicker.add(cur.category);
    }
    for (const cat of BOOKING_RELATED) {
      expect(categoriesWithPicker.has(cat), `expected a picker path for ${cat}`).toBe(true);
    }
  });
});
