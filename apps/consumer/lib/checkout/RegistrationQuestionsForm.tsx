'use client';

import { useState } from 'react';
import type { PublicEventQuestion } from '@/lib/api/types';
import { Button, Input } from '@/lib/ui';

/**
 * Pre-payment step for events with registration questions: the organiser's
 * custom questions ("T-shirt size?", "Dietary restrictions?"), answered once
 * per booking. Mirrors ContactDetailsForm — collected before the payment view,
 * handed back to CheckoutModal which sends them with the booking.
 */
export function RegistrationQuestionsForm({
  questions,
  onSubmit,
}: {
  questions: PublicEventQuestion[];
  onSubmit: (answers: Record<string, string>) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  function set(questionId: string, value: string) {
    setValues((v) => ({ ...v, [questionId]: value }));
  }

  function onContinue() {
    const next: Record<string, string> = {};
    for (const q of questions) {
      if (q.required && !(values[q.id] ?? '').trim()) {
        next[q.id] = 'This question needs an answer.';
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
      {questions.map((q) =>
        q.type === 'select' ? (
          <div key={q.id} className="flex flex-col gap-1">
            <label className="text-sm font-medium text-[var(--color-ink)]">
              {q.label}
              {!q.required && (
                <span className="ml-1 text-xs font-normal text-[var(--color-text-secondary)]">
                  (optional)
                </span>
              )}
            </label>
            <select
              value={values[q.id] ?? ''}
              onChange={(e) => set(q.id, e.target.value)}
              className="w-full rounded-[var(--radius)] border-[2px] border-ink bg-white px-3 py-2 text-sm text-[var(--color-ink)]"
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
            label={q.required ? q.label : `${q.label} (optional)`}
            value={values[q.id] ?? ''}
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
