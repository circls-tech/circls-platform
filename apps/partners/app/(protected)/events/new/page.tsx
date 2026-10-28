'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { useOrg } from '@/lib/org_context';
import { useEvent } from '@/lib/api/events';
import { FormAutosaveScope } from '@/lib/use_form_autosave';
import { CirclsHelp } from '@/components/CirclsHelp';
import { NewEventForm } from '@/components/NewEventForm';
import { BackLink } from '@/lib/ui';

export default function NewTenantEventPage() {
  // useSearchParams needs a Suspense boundary on a statically-rendered route.
  return (
    <Suspense fallback={null}>
      <NewTenantEventRoute />
    </Suspense>
  );
}

/**
 * Resolves the tenant and, for `?from=<eventId>` (an event's Duplicate
 * button), loads the event to copy before the form mounts. The form is keyed
 * on tenant + source, so it is born seeded rather than patched after the
 * fact: nothing the organiser types can be overwritten by a late fetch, and
 * switching organisation or dropping `?from` gives a fresh blank form.
 */
function NewTenantEventRoute() {
  const router = useRouter();
  const params = useSearchParams();
  const fromId = params.get('from');
  const { activeTenantId } = useOrg();
  // The ?tenantId link param first (venue-scoped pages carry it); without it,
  // the active organisation.
  const tenantId = params.get('tenantId') || activeTenantId || '';
  const { data: source, error: sourceError } = useEvent(tenantId, fromId);

  if (!tenantId) {
    return <p className="text-sm text-slate-500">Select an organization first.</p>;
  }

  const sourcePending = Boolean(fromId) && !source && !sourceError;

  return (
    // The docked preview sets the room it needs while it is open.
    <div className="flex flex-col gap-6 xl:pr-[var(--scratch-preview-w,0px)]">
      <BackLink href="/events">Events</BackLink>
      <h1 className="font-[family-name:var(--font-display)] text-2xl font-extrabold tracking-tight text-[#17151D]">
        {fromId ? 'Duplicate event' : 'New event'}
      </h1>
      <CirclsHelp lead="Need a hand with this event?" />

      {fromId && (
        <p className="rounded-[var(--radius)] border border-[#e5e7eb] bg-slate-50 px-3 py-2 text-sm text-slate-600">
          {sourceError ? (
            <>Couldn’t load the event to copy ({sourceError.message}) — the form below starts blank.</>
          ) : source ? (
            <>
              Copying <span className="font-medium text-slate-800">{source.name}</span>. Dates,
              recurrence and photos aren’t copied — set new dates below. The copy is saved as a
              separate draft; the original is left as it is.
            </>
          ) : (
            <>Loading the event to copy…</>
          )}
        </p>
      )}

      {!sourcePending && (
        <FormAutosaveScope>
          <NewEventForm
            key={`${tenantId}:${source?.id ?? 'blank'}`}
            tenantId={tenantId}
            source={source ?? null}
            // A photo that didn't upload is added from the event's page.
            onCreated={(eventId, photoError) => router.push(photoError ? `/events/${eventId}` : '/events')}
          />
        </FormAutosaveScope>
      )}
    </div>
  );
}
