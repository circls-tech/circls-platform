'use client';
import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import { useOrg } from '@/lib/org_context';
import { useVenues, useCreateVenue } from '@/lib/api/queries';
import { Badge, Button, Card, Input, Modal, StatusPill, TagsInput } from '@/lib/ui';

function AddVenueModal({
  tenantId,
  open,
  onClose,
}: {
  tenantId: string;
  open: boolean;
  onClose: () => void;
}) {
  const createVenue = useCreateVenue(tenantId);
  const [name, setName] = useState('');
  const [tzName, setTzName] = useState('Asia/Kolkata');
  const [tags, setTags] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  function handleClose() {
    setName('');
    setTzName('Asia/Kolkata');
    setTags([]);
    setError(null);
    onClose();
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) { setError('Venue name is required.'); return; }
    try {
      await createVenue.mutateAsync({ name: name.trim(), tzName: tzName.trim() || undefined, tags });
      handleClose();
    } catch (err) {
      setError((err as Error).message ?? 'Could not create venue.');
    }
  }

  return (
    <Modal open={open} onClose={handleClose} title="Add venue">
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <Input
          label="Venue name"
          placeholder="e.g. Greenfield Main Campus"
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={error && !name.trim() ? error : undefined}
          autoFocus
        />
        <Input
          label="Timezone"
          placeholder="Asia/Kolkata"
          value={tzName}
          onChange={(e) => setTzName(e.target.value)}
          hint="IANA timezone, e.g. Asia/Kolkata"
        />
        <TagsInput
          label="Tags (optional)"
          value={tags}
          onChange={setTags}
          placeholder="e.g. indoor, premium…"
        />
        {error && name.trim() && (
          <p className="text-sm text-red-600">{error}</p>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={handleClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            loading={createVenue.isPending}
            disabled={!name.trim()}
          >
            Add venue
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function VenueList({
  tenantId,
  onAddVenue,
}: {
  tenantId: string;
  onAddVenue: () => void;
}) {
  const { data: venues, isLoading } = useVenues(tenantId);

  if (isLoading) {
    return <p className="text-sm text-slate-500">Loading venues…</p>;
  }

  if (!venues || venues.length === 0) {
    return (
      <Card className="flex flex-col items-start gap-3">
        <p className="text-sm text-slate-500">
          No venues yet for this organization.
        </p>
        <Button variant="secondary" size="sm" onClick={onAddVenue}>
          + Add venue
        </Button>
      </Card>
    );
  }

  return (
    <ul className="flex flex-col gap-3">
      {venues.map((v) => (
        <li key={v.id}>
          <Link
            href={`/venues/${v.id}?tenantId=${tenantId}`}
            className="block rounded-[var(--radius)] border border-[#e5e7eb] bg-white p-4 shadow-sm transition-shadow hover:shadow-md"
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-[#0f172a]">{v.name}</p>
                <p className="mt-0.5 text-xs text-slate-400">
                  {v.tzName}
                  {v.lat != null && v.lng != null
                    ? ` · ${v.lat.toFixed(4)}, ${v.lng.toFixed(4)}`
                    : ''}
                </p>
              </div>
              <StatusPill status={v.status} />
            </div>
            {v.tags && v.tags.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {v.tags.map((tag) => (
                  <Badge key={tag} tone="neutral" label={tag} />
                ))}
              </div>
            )}
          </Link>
        </li>
      ))}
    </ul>
  );
}

export default function VenuesPage() {
  const { activeTenantId, tenants } = useOrg();
  const activeTenant = tenants.find((t) => t.id === activeTenantId);
  const [showAddVenue, setShowAddVenue] = useState(false);

  if (!activeTenantId) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-xl font-semibold text-[#0f172a]">Venues</h1>
        <Card subtitle="Select or create an organization first to view its venues.">
          <p className="text-sm text-slate-500">
            No active organization. Use the switcher in the top bar to pick one.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-[#0f172a]">Venues</h1>
          {activeTenant && (
            <p className="mt-0.5 text-sm text-slate-500">{activeTenant.name}</p>
          )}
        </div>
        <Button variant="primary" size="sm" onClick={() => setShowAddVenue(true)}>
          + Add venue
        </Button>
      </div>
      <VenueList tenantId={activeTenantId} onAddVenue={() => setShowAddVenue(true)} />
      <AddVenueModal
        tenantId={activeTenantId}
        open={showAddVenue}
        onClose={() => setShowAddVenue(false)}
      />
    </div>
  );
}
