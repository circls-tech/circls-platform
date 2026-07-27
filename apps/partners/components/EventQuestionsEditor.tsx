'use client';

import { Button, Input } from '@/lib/ui';
import type { EventQuestion } from '@/lib/api/types';
import type { EventQuestionInput } from '@/lib/api/events';

/** Cap on questions per event — keep in sync with the API's MAX_EVENT_QUESTIONS. */
export const MAX_EVENT_QUESTIONS = 20;

/** Form-draft shape: select options are edited as one comma-separated string. */
export interface QuestionDraft {
  label: string;
  type: 'text' | 'select';
  required: boolean;
  /** Comma-separated choices; only meaningful when type === 'select'. */
  optionsText: string;
}

export function emptyQuestion(): QuestionDraft {
  return { label: '', type: 'text', required: false, optionsText: '' };
}

/** Convert drafts to the API payload shape, dropping rows with a blank label. */
export function questionsToPayload(questions: QuestionDraft[]): EventQuestionInput[] {
  return questions
    .map((q) => ({
      label: q.label.trim(),
      type: q.type,
      required: q.required,
      ...(q.type === 'select'
        ? {
            options: q.optionsText
              .split(',')
              .map((o) => o.trim())
              .filter((o) => o.length > 0),
          }
        : {}),
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
 * Registration-questions builder: the organiser's custom questions consumers
 * answer when booking the event ("T-shirt size?", "Dietary restrictions?").
 * Controlled — the parent owns the array. Editable only while the event is
 * draft, like ticket tiers.
 */
export function EventQuestionsEditor({
  value,
  onChange,
  disabled,
}: {
  value: QuestionDraft[];
  onChange: (next: QuestionDraft[]) => void;
  disabled?: boolean;
}) {
  function update(i: number, patch: Partial<QuestionDraft>) {
    onChange(value.map((q, j) => (j === i ? { ...q, ...patch } : q)));
  }
  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= value.length) return;
    const next = value.slice();
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  }

  return (
    <div className="flex flex-col gap-3">
      <label className="text-xs font-medium uppercase tracking-wide text-[#475569]">
        Registration questions
      </label>
      {value.length === 0 && (
        <p className="text-xs text-slate-400">
          Optional — ask attendees for anything extra you need (e.g. T-shirt size, dietary
          restrictions). Answers are collected when they book.
        </p>
      )}
      {value.map((q, i) => (
        <div
          key={i}
          className="grid grid-cols-1 gap-3 rounded-[var(--radius)] border border-[#e5e7eb] bg-slate-50 p-3 sm:grid-cols-12"
        >
          <div className="sm:col-span-7">
            <Input
              label="Question"
              placeholder="e.g. What is your T-shirt size?"
              value={q.label}
              disabled={disabled}
              onChange={(e) => update(i, { label: e.target.value })}
            />
          </div>
          <div className="sm:col-span-3">
            <label className="flex flex-col gap-1 text-xs font-medium text-[#475569]">
              Answer type
              <select
                value={q.type}
                disabled={disabled}
                onChange={(e) => update(i, { type: e.target.value as QuestionDraft['type'] })}
                className="rounded border border-gray-300 bg-white px-2 py-2 text-sm font-normal text-slate-900"
              >
                <option value="text">Free text</option>
                <option value="select">Multiple choice</option>
              </select>
            </label>
          </div>
          <div className="flex items-end pb-2 sm:col-span-2">
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={q.required}
                disabled={disabled}
                onChange={(e) => update(i, { required: e.target.checked })}
              />
              Required
            </label>
          </div>
          {q.type === 'select' && (
            <div className="sm:col-span-12">
              <Input
                label="Options (comma-separated)"
                placeholder="e.g. Small, Medium, Large"
                value={q.optionsText}
                disabled={disabled}
                onChange={(e) => update(i, { optionsText: e.target.value })}
              />
            </div>
          )}
          {!disabled && (
            <div className="flex items-center justify-end gap-1 sm:col-span-12">
              <button
                type="button"
                onClick={() => move(i, -1)}
                disabled={i === 0}
                className="rounded border border-gray-200 px-2 py-1 text-xs text-slate-500 disabled:opacity-40 hover:bg-white"
                aria-label="Move up"
              >
                ↑
              </button>
              <button
                type="button"
                onClick={() => move(i, 1)}
                disabled={i === value.length - 1}
                className="rounded border border-gray-200 px-2 py-1 text-xs text-slate-500 disabled:opacity-40 hover:bg-white"
                aria-label="Move down"
              >
                ↓
              </button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-red-600 hover:bg-red-50"
                onClick={() => onChange(value.filter((_, j) => j !== i))}
              >
                Remove
              </Button>
            </div>
          )}
        </div>
      ))}
      {!disabled && (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="self-start"
          disabled={value.length >= MAX_EVENT_QUESTIONS}
          onClick={() => onChange([...value, emptyQuestion()])}
        >
          + Add question
        </Button>
      )}
    </div>
  );
}
