'use client';

import { useState } from 'react';
import type { PublicEventQuestion } from '@/lib/api/types';
import { Button, Input } from '@/lib/ui';
import { isAnswerBlank, type RegistrationAnswers } from './answers';

const FIELD_CLASS =
  'w-full rounded-[var(--radius)] border-[2px] border-ink bg-white px-3 py-2 text-sm text-[var(--color-ink)]';

/** Same label treatment as the shared Input, so every question reads alike. */
const LABEL_CLASS = 'font-display text-xs font-bold uppercase tracking-wide text-ink';

/** Label text the way Input formats it: the question, plus "(optional)" when it is. */
function labelText(q: PublicEventQuestion): string {
  return q.required ? q.label : `${q.label} (optional)`;
}

/** The string form of an answer for text inputs ('' when unanswered or multi-select). */
function textValue(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Pre-payment step for events with registration questions: the organiser's
 * custom questions ("T-shirt size?", "Dietary restrictions?"), answered once
 * per booking. Mirrors ContactDetailsForm — collected before the payment view,
 * handed back to CheckoutModal which sends them with the booking. Free-text
 * and single-choice questions hold a string; multi-select questions hold the
 * ticked options.
 */
export function RegistrationQuestionsForm({
  questions,
  initial,
  serverError,
  onSubmit,
}: {
  questions: PublicEventQuestion[];
  /** Previously entered answers (coming back from the payment view). */
  initial?: RegistrationAnswers;
  /** A rejection from the booking call, shown until the form is resubmitted. */
  serverError?: string | null;
  onSubmit: (answers: RegistrationAnswers) => void;
}) {
  const [values, setValues] = useState<RegistrationAnswers>(initial ?? {});
  const [errors, setErrors] = useState<Record<string, string>>({});

  function set(questionId: string, value: string) {
    setValues((v) => ({ ...v, [questionId]: value }));
  }

  function toggle(questionId: string, option: string, on: boolean) {
    setValues((v) => {
      const current = v[questionId];
      const chosen = new Set(Array.isArray(current) ? current : []);
      if (on) chosen.add(option);
      else chosen.delete(option);
      return { ...v, [questionId]: [...chosen] };
    });
  }

  function onContinue() {
    const next: Record<string, string> = {};
    for (const q of questions) {
      if (q.required && isAnswerBlank(values[q.id])) {
        next[q.id] =
          q.type === 'multiselect' ? 'Tick at least one option.' : 'This question needs an answer.';
      }
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    onSubmit(values);
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-[var(--color-text-secondary)]">
        The organiser needs a few details for this event.
      </p>
      {serverError && <p className="text-xs font-semibold text-petal-red">{serverError}</p>}
      {questions.map((q) =>
        q.type === 'multiselect' ? (
          <fieldset key={q.id} className="flex flex-col gap-1.5">
            <legend className={`${LABEL_CLASS} mb-1.5`}>{labelText(q)}</legend>
            <div className={`${FIELD_CLASS} flex flex-col gap-1.5`}>
              {(q.options ?? []).map((o) => {
                const chosen = values[q.id];
                const checked = Array.isArray(chosen) && chosen.includes(o);
                return (
                  <label key={o} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => toggle(q.id, o, e.target.checked)}
                      className="h-4 w-4 accent-[var(--color-ink)]"
                    />
                    {o}
                  </label>
                );
              })}
            </div>
            {errors[q.id] ? (
              <p className="text-xs font-semibold text-petal-red">{errors[q.id]}</p>
            ) : (
              <p className="text-xs text-text-muted">Tick all that apply.</p>
            )}
          </fieldset>
        ) : q.type === 'select' ? (
          <div key={q.id} className="flex flex-col gap-1.5">
            <label className={LABEL_CLASS}>{labelText(q)}</label>
            <select
              value={textValue(values[q.id])}
              onChange={(e) => set(q.id, e.target.value)}
              className={FIELD_CLASS}
            >
              <option value="">Select…</option>
              {(q.options ?? []).map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
            {errors[q.id] && <p className="text-xs font-semibold text-petal-red">{errors[q.id]}</p>}
          </div>
        ) : (
          <Input
            key={q.id}
            label={labelText(q)}
            value={textValue(values[q.id])}
            onChange={(e) => set(q.id, e.target.value)}
            maxLength={2000}
            {...(errors[q.id] ? { error: errors[q.id] } : {})}
          />
        ),
      )}
      <Button className="mt-1" onClick={onContinue}>
        Continue
      </Button>
    </div>
  );
}
