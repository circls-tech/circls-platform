import { describe, expect, it } from 'vitest';
import type { PublicEventQuestion } from '@/lib/api/types';
import { isAnswerBlank, toAnswerPayload } from './answers';

const question = (id: string, type: PublicEventQuestion['type']): PublicEventQuestion => ({
  id,
  label: id,
  type,
  required: false,
  options: type === 'text' ? null : ['A', 'B'],
});

describe('toAnswerPayload', () => {
  it('sends trimmed strings and ticked-option arrays, skipping blanks', () => {
    const questions = [
      question('t', 'text'),
      question('s', 'select'),
      question('m', 'multiselect'),
      question('untouched', 'multiselect'),
      question('blank', 'text'),
    ];
    expect(
      toAnswerPayload(questions, {
        t: '  hello ',
        s: 'A',
        m: ['B', 'A'],
        untouched: [],
        blank: '  ',
      }),
    ).toEqual([
      { questionId: 't', answer: 'hello' },
      { questionId: 's', answer: 'A' },
      { questionId: 'm', answer: ['B', 'A'] },
    ]);
  });

  it('is empty before the questions step has been completed', () => {
    expect(toAnswerPayload([question('t', 'text')], null)).toEqual([]);
  });
});

describe('isAnswerBlank', () => {
  it('treats whitespace and an empty tick list as unanswered', () => {
    expect(isAnswerBlank(undefined)).toBe(true);
    expect(isAnswerBlank('   ')).toBe(true);
    expect(isAnswerBlank([])).toBe(true);
    expect(isAnswerBlank('M')).toBe(false);
    expect(isAnswerBlank(['Vegan'])).toBe(false);
  });
});
