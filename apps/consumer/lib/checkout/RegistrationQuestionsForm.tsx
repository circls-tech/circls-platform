'use client';

import { useState } from 'react';
import type { PublicEventQuestion } from '@/lib/api/types';
import { Button, Input } from '@/lib/ui';
import { Field, fieldAria } from '@/lib/ui/Input';
import { isAnswerBlank, type RegistrationAnswers } from './answers';

const FIELD_CLASS =
  'w-full rounded-[var(--radius)] border-[2px] border-ink bg-white px-3 py-2 text-sm text-[var(--color-ink)]';

const TICK_HINT = 'Tick all that apply.';

/** The string form of an answer for text inputs ('' when unanswered or multi-select). */
function textValue(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : '';
}

/** Label text the way Input formats it: the question, plus "(optional)" when it is. */
function labelText(q: PublicEventQuestion): string {
  return q.required ? q.label : `${q.label} (optional)`;
}

/**
 * Pre-payment step for events with registration questions: the organiser's
 * custom questions ("T-shirt size?", "Dietary restrictions?"), answered once
 * per booking. Mirrors ContactDetailsForm — collected before the payment view,
 * handed back to CheckoutModal which sends them with the booking. Free-text
 * and single-choice questions hold a string; multi-select questions hold the
 * ticked options. Every question is wrapped in the shared Field chrome so the
 * three kinds read alike and errors are announced.
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
      {questions.map((q) => {
        const id = `question-${q.id}`;
        const error = errors[q.id];
        if (q.type === 'multiselect') {
          return (
            <Field key={q.id} id={id} group label={labelText(q)} hint={TICK_HINT} error={error}>
              <div
                id={id}
                role="group"
                aria-labelledby={`${id}-label`}
                {...fieldAria(id, error, TICK_HINT)}
                className={`${FIELD_CLASS} flex flex-col gap-1.5`}
              >
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
            </Field>
          );
        }
        if (q.type === 'select') {
          return (
            <Field key={q.id} id={id} label={labelText(q)} error={error}>
              <select
                id={id}
                value={textValue(values[q.id])}
                onChange={(e) => set(q.id, e.target.value)}
                {...fieldAria(id, error)}
                className={FIELD_CLASS}
              >
                <option value="">Select…</option>
                {(q.options ?? []).map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </Field>
          );
        }
        return (
          <Input
            key={q.id}
            id={id}
            label={labelText(q)}
            value={textValue(values[q.id])}
            onChange={(e) => set(q.id, e.target.value)}
            maxLength={2000}
            {...(error ? { error } : {})}
          />
        );
      })}
      <Button className="mt-1" onClick={onContinue}>
        Continue
      </Button>
    </div>
  );
}
