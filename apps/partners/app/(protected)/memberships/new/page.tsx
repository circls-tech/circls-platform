'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
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
  // Saved, but the artwork didn't upload: said here, where they can read it,
  // rather than lost in the move to the plan's page.
  const [uploadProblem, setUploadProblem] = useState<{ planId: string; message: string } | null>(null);
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

      {uploadProblem ? (
        <div role="alert" className="flex flex-col items-start gap-2 rounded-[var(--radius)] border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <p>{uploadProblem.message}</p>
          <Link href={`/memberships/${uploadProblem.planId}`} className="font-semibold underline hover:no-underline">
            Open the plan
          </Link>
        </div>
      ) : (
        // Keyed on the organisation: switching it opens that one's form,
        // blank or as it was left.
        <FormAutosaveScope>
          <NewPlanForm
            key={tenantId}
            tenantId={tenantId}
            onCreated={(planId, { artworkError }) =>
              artworkError ? setUploadProblem({ planId, message: artworkError }) : router.push(`/memberships/${planId}`)
            }
          />
        </FormAutosaveScope>
      )}
    </div>
  );
}
