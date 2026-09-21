import { describe, expect, it } from 'vitest';
import { isAnswerBlank, textAnswer, toAnswerPayload, toggleAnswerOption } from './answers';

const q = (id: string) => ({ id });

describe('toAnswerPayload', () => {
  it('sends trimmed strings and ticked-option arrays, skipping blanks', () => {
    expect(
      toAnswerPayload([q('t'), q('s'), q('m'), q('untouched'), q('blank')], {
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
});

describe('toggleAnswerOption', () => {
  it('adds and removes options without touching other answers', () => {
    const ticked = toggleAnswerOption({ t: 'x' }, 'm', 'A', true);
    expect(ticked).toEqual({ t: 'x', m: ['A'] });
    expect(toggleAnswerOption(ticked, 'm', 'B', true)).toEqual({ t: 'x', m: ['A', 'B'] });
    expect(toggleAnswerOption(ticked, 'm', 'A', false)).toEqual({ t: 'x', m: [] });
  });
});

describe('blank and text helpers', () => {
  it('treats whitespace and an empty tick list as unanswered', () => {
    expect(isAnswerBlank(undefined)).toBe(true);
    expect(isAnswerBlank('   ')).toBe(true);
    expect(isAnswerBlank([])).toBe(true);
    expect(isAnswerBlank('M')).toBe(false);
    expect(isAnswerBlank(['Vegan'])).toBe(false);
  });

  it('only exposes strings to text inputs', () => {
    expect(textAnswer('M')).toBe('M');
    expect(textAnswer(['A'])).toBe('');
    expect(textAnswer(undefined)).toBe('');
  });
});
