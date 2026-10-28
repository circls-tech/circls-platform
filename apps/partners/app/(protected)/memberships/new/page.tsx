'use client';

import { useRouter } from 'next/navigation';
import { useOrg } from '@/lib/org_context';
import { BackLink } from '@/lib/ui';
import { CirclsHelp } from '@/components/CirclsHelp';
import { NewPlanForm } from '@/components/NewPlanForm';
import { FormAutosaveScope } from '@/lib/use_form_autosave';

/**
 * Creating a plan, on its own page.
 *
 * It used to sit permanently below the plans table, so every visit to
 * Memberships opened on a long empty form regardless of what you came to do.
 * Mirrors /events/new.
 */
export default function NewMembershipPage() {
  const router = useRouter();
  const { activeTenantId } = useOrg();
  const tenantId = activeTenantId ?? '';
  return (
    // The docked preview sets the room it needs while it is open.
    <div className="flex flex-col gap-4 xl:pr-[var(--scratch-preview-w,0px)]">
      <div>
        <BackLink href="/memberships">Memberships</BackLink>
        <h1 className="mt-3 font-[family-name:var(--font-display)] text-2xl font-extrabold tracking-tight text-[#17151D]">
          New plan
        </h1>
      </div>
      <CirclsHelp lead="Need a hand with this plan?" />

      {/* Keyed on the organisation: switching it opens that one's form, blank
          or as it was left. An artwork that didn't upload is added from the
          plan's page, where both outcomes land. */}
      <FormAutosaveScope>
        <NewPlanForm
          key={tenantId}
          tenantId={tenantId}
          onCreated={(planId) => router.push(`/memberships/${planId}`)}
        />
      </FormAutosaveScope>
    </div>
  );
}
