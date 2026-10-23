'use client';

import { type FormEvent, useState } from 'react';
import { RejectionNotice } from '@/components/RejectionNotice';
import { useSubmitArena, useUpdateArenaDetails } from '@/lib/api/queries';
import { inferSport } from '@/lib/api/sport_inference';
import type { Arena } from '@/lib/api/types';
import { Button, Card, Input, TagsInput } from '@/lib/ui';

/**
 * A rejected arena's way back: what Circls asked to change, the details it
 * reviewed (name, sport, capacity, slot length, tags) open for editing, and
 * "Submit again". Arenas have no draft stage, so this is the only time those
 * details can change — once back in review or live, they are what Circls
 * approved.
 */
export function RejectedArenaFix({ arena, canWrite }: { arena: Arena; canWrite: boolean }) {
  const update = useUpdateArenaDetails(arena.id, arena.venueId);
  const submit = useSubmitArena(arena.id, arena.venueId);
  const [name, setName] = useState(arena.name);
  const [sport, setSport] = useState(arena.sport ?? '');
  const [capacity, setCapacity] = useState(arena.capacity != null ? String(arena.capacity) : '');
  const [slotMin, setSlotMin] = useState(String(arena.slotDurationMin));
  const [tags, setTags] = useState<string[]>(arena.tags ?? []);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const inferredSport = !sport ? inferSport(tags) : null;

  async function onSave(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setSaved(false);
    try {
      await update.mutateAsync({
        name: name.trim(),
        sport: sport.trim() || null,
        capacity: capacity.trim() ? Number(capacity) : null,
        slotDurationMin: Number(slotMin),
        tags,
      });
      setSaved(true);
    } catch (e2) {
      setErr((e2 as Error).message);
    }
  }

  async function onSubmitAgain() {
    setErr(null);
    try {
      await submit.mutateAsync();
    } catch (e2) {
      setErr((e2 as Error).message);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <RejectionNotice rejection={arena.rejection} noun="arena" canWrite={canWrite} />
      {canWrite && (
        <Card title="Fix this arena" subtitle="Save your changes, then submit the arena again.">
          <form onSubmit={onSave} className="flex max-w-md flex-col gap-3">
            <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
            <Input
              label="Sport"
              value={sport}
              onChange={(e) => setSport(e.target.value)}
              maxLength={80}
              placeholder={inferredSport ? `${inferredSport} (from tags)` : 'Optional'}
            />
            <Input
              label="Capacity"
              type="number"
              min={1}
              step={1}
              value={capacity}
              onChange={(e) => setCapacity(e.target.value)}
              placeholder="Optional"
            />
            <Input
              label="Default slot length (minutes)"
              type="number"
              min={5}
              max={1440}
              step={5}
              value={slotMin}
              onChange={(e) => setSlotMin(e.target.value)}
              required
            />
            <TagsInput label="Tags" value={tags} onChange={setTags} />
            {err && <p className="text-sm text-red-600">{err}</p>}
            {saved && !err && <p className="text-sm text-emerald-700">Saved.</p>}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="secondary" size="sm" loading={update.isPending}>
                Save changes
              </Button>
              <Button
                type="button"
                petal="#A7E3BF"
                size="sm"
                loading={submit.isPending}
                disabled={update.isPending}
                onClick={() => void onSubmitAgain()}
              >
                Submit again
              </Button>
            </div>
          </form>
        </Card>
      )}
    </div>
  );
}
