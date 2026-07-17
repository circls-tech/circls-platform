'use client';

import { useState } from 'react';
import type { EventTier } from '@/lib/api/types';
import type { UpdateEventInput } from '@/lib/api/events';
import { Button, Card, Input } from '@/lib/ui';
import { MaxPerUserField, maxPerUserFromApi, maxPerUserToPayload } from './MaxPerUserField';

/**
 * The settings a PUBLISHED event may still change: tier capacity (increase
 * only — higher, or blank for unlimited; the API rejects decreases so tickets
 * already sold are never invalidated) and the per-customer ticket limit (any
 * change; it only gates future purchases). Sends only the fields that changed.
 */
export function LiveEventSettings({
  tiers,
  maxPerUser,
  onSave,
  saving,
}: {
  tiers: EventTier[];
  maxPerUser: number | null;
  onSave: (input: Pick<UpdateEventInput, 'maxPerUser' | 'tierCapacities'>) => Promise<void>;
  saving: boolean;
}) {
  // Capacity drafts keyed by tier id ('' = unlimited); seeded from the live values.
  const [caps, setCaps] = useState<Record<string, string>>(() =>
    Object.fromEntries(tiers.map((t) => [t.id, t.capacity == null ? '' : String(t.capacity)])),
  );
  const [limit, setLimit] = useState<string | null>(() => maxPerUserFromApi(maxPerUser));
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
  const dirty = capacityChanges.length > 0 || limitChanged;

  async function save() {
    setError(null);
    setSaved(false);
    try {
      await onSave({
        ...(limitChanged ? { maxPerUser: maxPerUserToPayload(limit) } : {}),
        ...(capacityChanges.length > 0 ? { tierCapacities: capacityChanges } : {}),
      });
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Card title="Live settings">
      <p className="mb-4 text-xs text-slate-500">
        These can change while the event is live. Capacity can only go up (or blank for unlimited)
        and the per-customer limit only affects future purchases — tickets people already hold are
        never touched.
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
