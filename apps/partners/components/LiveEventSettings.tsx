'use client';

import { useState } from 'react';
import type { EventQuestion, EventTier, QrTicketConfig } from '@/lib/api/types';
import type { UpdateEventInput } from '@/lib/api/events';
import { Button, Card, Input } from '@/lib/ui';
import { MaxPerUserField, maxPerUserFromApi, maxPerUserToPayload } from './MaxPerUserField';
import {
  EventQuestionsEditor,
  questionDraftFromApi,
  questionsToPayload,
  type QuestionDraft,
} from './EventQuestionsEditor';
import { QrTicketConfigEditor } from './QrTicketConfigEditor';

/**
 * The settings a PUBLISHED event may still change freely (no circls review):
 * tier capacity (increase only — higher, or blank for unlimited; the API
 * rejects decreases so tickets already sold are never invalidated), the
 * per-customer ticket limit, the description, QR ticket rules, and
 * registration questions. Sends only the fields that changed. Name, date/time,
 * location, and tier structure go through a change request instead (see
 * EventChangeRequests).
 */
export function LiveEventSettings({
  tiers,
  maxPerUser,
  description,
  qrTicketConfig,
  questions,
  onSave,
  saving,
}: {
  tiers: EventTier[];
  maxPerUser: number | null;
  description: string | null;
  qrTicketConfig: QrTicketConfig | null;
  questions: EventQuestion[];
  onSave: (
    input: Pick<
      UpdateEventInput,
      'maxPerUser' | 'tierCapacities' | 'description' | 'qrTicketConfig' | 'questions'
    >,
  ) => Promise<void>;
  saving: boolean;
}) {
  // Capacity drafts keyed by tier id ('' = unlimited); seeded from the live values.
  const [caps, setCaps] = useState<Record<string, string>>(() =>
    Object.fromEntries(tiers.map((t) => [t.id, t.capacity == null ? '' : String(t.capacity)])),
  );
  const [limit, setLimit] = useState<string | null>(() => maxPerUserFromApi(maxPerUser));
  const [descDraft, setDescDraft] = useState(description ?? '');
  const [qrDraft, setQrDraft] = useState<QrTicketConfig | null>(qrTicketConfig);
  const [questionDrafts, setQuestionDrafts] = useState<QuestionDraft[]>(() =>
    questions.map(questionDraftFromApi),
  );
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function draftCapacity(tierId: string): number | null {
    const raw = (caps[tierId] ?? '').trim();
    return raw ? parseInt(raw, 10) : null;
  }

  const capacityChanges = tiers
    .filter((t) => draftCapacity(t.id) !== t.capacity)
    .map((t) => ({ tierId: t.id, capacity: draftCapacity(t.id) }));
  const limitChanged = maxPerUserToPayload(limit) !== maxPerUser;
  const descriptionChanged = descDraft !== (description ?? '');
  const qrChanged = JSON.stringify(qrDraft) !== JSON.stringify(qrTicketConfig);
  const questionsChanged =
    JSON.stringify(questionsToPayload(questionDrafts)) !==
    JSON.stringify(questionsToPayload(questions.map(questionDraftFromApi)));
  const dirty =
    capacityChanges.length > 0 || limitChanged || descriptionChanged || qrChanged || questionsChanged;

  async function save() {
    setError(null);
    setSaved(false);
    if (
      questionsChanged &&
      questionDrafts.some(
        (q) =>
          q.label.trim() &&
          q.type === 'select' &&
          q.optionsText.split(',').filter((o) => o.trim()).length < 2,
      )
    ) {
      setError('Give every multiple-choice question at least 2 options.');
      return;
    }
    try {
      await onSave({
        ...(limitChanged ? { maxPerUser: maxPerUserToPayload(limit) } : {}),
        ...(capacityChanges.length > 0 ? { tierCapacities: capacityChanges } : {}),
        ...(descriptionChanged ? { description: descDraft } : {}),
        ...(qrChanged ? { qrTicketConfig: qrDraft } : {}),
        ...(questionsChanged ? { questions: questionsToPayload(questionDrafts) } : {}),
      });
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Card title="Live settings">
      <p className="mb-4 text-xs text-slate-500">
        These can change while the event is live, without review. Capacity can only go up (or blank
        for unlimited) and the per-customer limit only affects future purchases — tickets people
        already hold are never touched. Editing a question mid-event keeps the answers people
        already gave under the old wording.
      </p>

      <div className="flex max-w-xl flex-col gap-3">
        {tiers.map((t) => (
          <div key={t.id} className="flex items-end justify-between gap-4">
            <div className="min-w-0 pb-2">
              <p className="truncate text-sm font-medium text-slate-700">{t.name}</p>
              <p className="text-xs text-slate-400">
                {t.sold} sold{t.capacity != null ? ` of ${t.capacity}` : ' · unlimited'}
              </p>
            </div>
            <div className="w-40 shrink-0">
              <Input
                label="Capacity"
                type="number"
                min={t.capacity ?? 1}
                inputMode="numeric"
                placeholder="Blank = unlimited"
                value={caps[t.id] ?? ''}
                onChange={(e) => setCaps((c) => ({ ...c, [t.id]: e.target.value }))}
              />
            </div>
          </div>
        ))}

        <MaxPerUserField value={limit} onChange={setLimit} />

        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium uppercase tracking-wide text-[#475569]">
            Description
          </label>
          <textarea
            value={descDraft}
            onChange={(e) => setDescDraft(e.target.value)}
            rows={3}
            className="w-full rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-3 py-2 text-sm text-[#0f172a] placeholder:text-[#94a3b8] hover:border-slate-300"
            placeholder="Optional"
          />
        </div>

        <EventQuestionsEditor value={questionDrafts} onChange={setQuestionDrafts} />

        <QrTicketConfigEditor value={qrDraft} onChange={setQrDraft} itemNoun="event" />

        {error && (
          <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
            {error}
          </p>
        )}

        <div className="flex items-center gap-3">
          <Button size="sm" loading={saving} disabled={!dirty} onClick={save}>
            Save live settings
          </Button>
          {saved && !dirty && <span className="text-xs text-emerald-600">Saved.</span>}
        </div>
      </div>
    </Card>
  );
}
