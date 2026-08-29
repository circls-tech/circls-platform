'use client';

import { type FormEvent, useState } from 'react';
import { useAddExternalRegistration } from '@/lib/api/events';
import { ApiError } from '@/lib/api/client';
import { type CurrencyCode, formatMoney } from '@/lib/currency';
import type { EventQuestion, EventTier } from '@/lib/api/types';
import { Button, Input, Modal } from '@/lib/ui';

export interface AddRegistrationModalProps {
  open: boolean;
  tenantId: string;
  eventId: string;
  eventName: string;
  tiers: EventTier[];
  questions: EventQuestion[];
  currency: CurrencyCode;
  onClose: () => void;
}

/**
 * Records someone who registered away from circls — at the door, over the
 * phone, or through the organiser's own form — so the event roll is complete.
 *
 * It asks for exactly what the consumer flow would have collected, because the
 * API applies the same rules: seats come out of tier capacity, and any question
 * marked required must be answered here too.
 */
export function AddRegistrationModal({
  open,
  tenantId,
  eventId,
  eventName,
  tiers,
  questions,
  currency,
  onClose,
}: AddRegistrationModalProps) {
  const add = useAddExternalRegistration(tenantId);

  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [note, setNote] = useState('');
  const [qty, setQty] = useState<Record<string, number>>({});
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const totalTickets = Object.values(qty).reduce((sum, n) => sum + n, 0);

  function reset() {
    setName('');
    setContact('');
    setNote('');
    setQty({});
    setAnswers({});
    setError(null);
  }

  function close() {
    reset();
    onClose();
  }

  const missingRequired = questions
    .filter((q) => q.required && !(answers[q.id] ?? '').trim())
    .map((q) => q.label);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const lines = Object.entries(qty)
      .filter(([, quantity]) => quantity > 0)
      .map(([tierId, quantity]) => ({ tierId, quantity }));
    if (lines.length === 0) {
      setError('Choose at least one ticket.');
      return;
    }
    try {
      await add.mutateAsync({
        eventId,
        input: {
          name: name.trim(),
          ...(contact.trim() ? { contact: contact.trim() } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
          lines,
          answers: questions
            .map((q) => ({ questionId: q.id, answer: (answers[q.id] ?? '').trim() }))
            .filter((a) => a.answer.length > 0),
        },
      });
      close();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    }
  }

  return (
    <Modal open={open} onClose={close} title={`Add a registration — ${eventName}`} maxWidth="max-w-xl">
      <form onSubmit={submit} className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto">
        <p className="rounded-[var(--radius)] bg-slate-50 px-3 py-2 text-xs text-slate-600">
          For someone who registered away from circls. They take up seats and
          count towards your limits exactly like any other attendee, but no money
          is recorded — whatever they paid, they paid you directly, so this never
          reaches a payout.
        </p>

        <Input
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          placeholder="Who attended"
        />
        <Input
          label="Contact (optional)"
          value={contact}
          onChange={(e) => setContact(e.target.value)}
          placeholder="Phone or email"
          hint="Used to send them their entry pass, if the event issues one."
        />

        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-[#475569]">
            Tickets
          </span>
          {tiers.map((t) => (
            <div
              key={t.id}
              className="flex items-center justify-between gap-3 rounded-[var(--radius)] border border-[#e5e7eb] px-3 py-2"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-slate-800">{t.name}</p>
                <p className="text-xs text-slate-500">
                  {t.pricePaise === 0 ? 'Free' : formatMoney(t.pricePaise, currency, { decimals: 2 })}
                  {t.capacity != null && ` · ${t.capacity} seat${t.capacity === 1 ? '' : 's'}`}
                </p>
              </div>
              <input
                type="number"
                min={0}
                max={100}
                inputMode="numeric"
                value={qty[t.id] ?? 0}
                onChange={(e) =>
                  setQty((prev) => ({ ...prev, [t.id]: Math.max(0, Number(e.target.value) || 0) }))
                }
                aria-label={`Tickets for ${t.name}`}
                className="w-20 rounded-md border border-slate-200 px-2 py-1 text-sm text-slate-700 focus:border-slate-400 focus:outline-none"
              />
            </div>
          ))}
        </div>

        {questions.length > 0 && (
          <div className="flex flex-col gap-3">
            <span className="text-xs font-medium uppercase tracking-wide text-[#475569]">
              Registration questions
            </span>
            {questions.map((q) =>
              q.type === 'select' ? (
                <label key={q.id} className="flex flex-col gap-1">
                  <span className="text-sm font-medium text-slate-700">
                    {q.label}
                    {q.required && <span className="text-red-600"> *</span>}
                  </span>
                  <select
                    value={answers[q.id] ?? ''}
                    onChange={(e) => setAnswers((p) => ({ ...p, [q.id]: e.target.value }))}
                    className="rounded-md border border-slate-200 px-3 py-2 text-sm text-slate-700 focus:border-slate-400 focus:outline-none"
                  >
                    <option value="">Select…</option>
                    {(q.options ?? []).map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <Input
                  key={q.id}
                  label={q.required ? `${q.label} *` : q.label}
                  value={answers[q.id] ?? ''}
                  onChange={(e) => setAnswers((p) => ({ ...p, [q.id]: e.target.value }))}
                />
              ),
            )}
          </div>
        )}

        <Input
          label="Note (optional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Anything worth recording"
        />

        {missingRequired.length > 0 && (
          <p className="text-xs text-slate-500">
            Still needed: {missingRequired.join(', ')}
          </p>
        )}
        {error && (
          <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-3">
          <Button type="button" variant="ghost" size="sm" onClick={close}>
            Cancel
          </Button>
          <Button
            type="submit"
            size="sm"
            loading={add.isPending}
            disabled={!name.trim() || totalTickets === 0 || missingRequired.length > 0}
          >
            Add registration
          </Button>
        </div>
      </form>
    </Modal>
  );
}
