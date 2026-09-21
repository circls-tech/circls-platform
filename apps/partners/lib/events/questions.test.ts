import { describe, expect, it } from 'vitest';
import {
  hasChoiceQuestionWithoutOptions,
  questionDraftFromApi,
  questionsToPayload,
  type QuestionType,
} from './questions';

describe('registration question drafts', () => {
  it('sends options for both choice types and none for free text', () => {
    expect(
      questionsToPayload([
        { label: ' Size ', type: 'select', required: true, optionsText: 'S, M ,L,' },
        { label: 'Diet', type: 'multiselect', required: false, optionsText: 'Vegan,Halal' },
        { label: 'Notes', type: 'text', required: false, optionsText: 'ignored' },
        { label: '  ', type: 'text', required: false, optionsText: '' },
      ]),
    ).toEqual([
      { label: 'Size', type: 'select', required: true, options: ['S', 'M', 'L'] },
      { label: 'Diet', type: 'multiselect', required: false, options: ['Vegan', 'Halal'] },
      { label: 'Notes', type: 'text', required: false },
    ]);
  });

  it('round-trips a multi-select question from the API', () => {
    const draft = questionDraftFromApi({
      label: 'Diet',
      type: 'multiselect',
      required: true,
      options: ['Vegan', 'Halal'],
    });
    expect(draft).toEqual({
      label: 'Diet',
      type: 'multiselect',
      required: true,
      optionsText: 'Vegan, Halal',
    });
    expect(questionsToPayload([draft])[0]).toMatchObject({
      type: 'multiselect',
      options: ['Vegan', 'Halal'],
    });
  });

  it('flags labelled choice questions with fewer than 2 options', () => {
    const row = (type: QuestionType, label: string, optionsText: string) => [
      { label, type, required: false, optionsText },
    ];
    expect(hasChoiceQuestionWithoutOptions(row('multiselect', 'Diet', 'Vegan'))).toBe(true);
    expect(hasChoiceQuestionWithoutOptions(row('select', 'Size', 'S'))).toBe(true);
    expect(hasChoiceQuestionWithoutOptions(row('select', 'Size', 'S, M'))).toBe(false);
    expect(hasChoiceQuestionWithoutOptions(row('multiselect', 'Diet', 'Vegan, Halal'))).toBe(false);
    // Blank rows are dropped from the payload, so they never block saving.
    expect(hasChoiceQuestionWithoutOptions(row('select', '', ''))).toBe(false);
    expect(hasChoiceQuestionWithoutOptions(row('text', 'Notes', ''))).toBe(false);
  });
});
