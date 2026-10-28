'use client';

import { type FormEvent, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/firebase/auth_context';
import { useOrg } from '@/lib/org_context';
import { useCreateMembership, useUploadMembershipCover } from '@/lib/api/memberships';
import { useMyRole, useTenantProfile, useVenues } from '@/lib/api/queries';
import { useVenueCurrencies } from '@/lib/currency';
import { BackLink, Button, Card } from '@/lib/ui';
import { CirclsHelp } from '@/components/CirclsHelp';
import { brandOf, scratchMembership } from '@/lib/api/scratch_listing';
import { ScratchPreview } from '@/components/ScratchPreview';
import { PendingPhotosPicker, type PendingPhoto } from '@/components/PendingPhotos';
import { RoleNotice } from '@/components/RoleNotice';
import { RestoredFormNotice } from '@/components/RestoredFormNotice';
import { FormAutosaveScope, useAutosave, useFormAutosave } from '@/lib/use_form_autosave';
import {
  MembershipPlanFields,
  emptyPlanDraft,
  planDraftToInput,
  type MembershipPlanDraft,
} from '@/components/MembershipPlanFields';

/**
 * Creating a plan, on its own page.
 *
 * It used to sit permanently below the plans table, so every visit to
 * Memberships opened on a long empty form regardless of what you came to do.
 * Mirrors /events/new.
 */
export default function NewMembershipPage() {
  const { activeTenantId } = useOrg();
  // Keyed on the organisation: switching it opens that one's form, blank or
  // as it was left.
  return (
    <FormAutosaveScope>
      <NewMembershipForm key={activeTenantId ?? ''} />
    </FormAutosaveScope>
  );
}

function NewMembershipForm() {
  const router = useRouter();
  // The customer-site preview of the form as it stands (nothing saved).
  const [previewOpen, setPreviewOpen] = useState(false);
  const { activeTenantId } = useOrg();
  const tenantId = activeTenantId ?? '';
  const autosave = useFormAutosave('plan-new', [tenantId], emptyPlanDraft);
  const { user } = useAuth();
  const authed = Boolean(user);

  const { data: venues } = useVenues(tenantId);
  const { data: profile } = useTenantProfile(tenantId);
  const { currencyFor } = useVenueCurrencies();
  const createMembership = useCreateMembership(tenantId);
  const uploadCover = useUploadMembershipCover(tenantId);
  // The form gives way to a notice only once the role has loaded, so the
  // notice never flashes at those who can create plans.
  const { can, isLoading: roleLoading } = useMyRole(tenantId);
  const cannotCreate = !roleLoading && !can('memberships.write');

  const [draft, setDraft] = useState<MembershipPlanDraft>(autosave.initial);
  useAutosave(autosave, draft);
  // A restored copy can name a venue removed since: once the venues load,
  // fall back to org-wide rather than send the old id.
  useEffect(() => {
    if (draft.venueId && venues && !venues.some((v) => v.id === draft.venueId)) {
      setDraft((d) => ({ ...d, venueId: '' }));
    }
  }, [venues, draft.venueId]);
  // The page is meaningless without a name; the rest may be blank.
  const canPreview = draft.name.trim().length > 0;
  useEffect(() => {
    if (!canPreview) setPreviewOpen(false);
  }, [canPreview]);
  const [artwork, setArtwork] = useState<PendingPhoto[]>([]);
  const [err, setErr] = useState<string | null>(null);
  // "Save as draft" sets this just before the form submits (with the
  // browser's own validation skipped), so the handler knows which it is.
  const asDraft = useRef(false);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    const isDraft = asDraft.current;
    asDraft.current = false;
    if (!draft.name.trim()) {
      setErr('Give the plan a name.');
      return;
    }
    try {
      // Create takes an absent venueId for org-wide, where update takes an
      // explicit null, so the shared input is spread rather than passed whole.
      // A draft keeps only the tiers that have a name; the rest can wait.
      const input = planDraftToInput({
        ...draft,
        tiers: isDraft ? draft.tiers.filter((t) => t.name.trim()) : draft.tiers,
      });
      const plan = await createMembership.mutateAsync({
        ...(isDraft ? { draft: true } : {}),
        name: input.name,
        ...(input.description ? { description: input.description } : {}),
        ...(input.venueId ? { venueId: input.venueId } : {}),
        ...(input.terms ? { terms: input.terms } : {}),
        tiers: input.tiers,
        qrTicketConfig: input.qrTicketConfig,
      });
      autosave.clear();
      if (artwork[0]) {
        try {
          await uploadCover.mutateAsync({ membershipId: plan.id, file: artwork[0].file });
        } catch (uploadErr) {
          // The plan exists — surface the artwork failure without undoing it,
          // and still land them on the plan so they can retry the upload there.
          setErr(
            `Plan created, but the artwork failed to upload (${(uploadErr as Error).message}) — add it from the plan's page.`,
          );
          router.push(`/memberships/${plan.id}`);
          return;
        }
      }
      router.push(`/memberships/${plan.id}`);
    } catch (e2) {
      setErr((e2 as Error).message);
    }
  }

  return (
    <div className={previewOpen ? 'flex flex-col gap-4 xl:pr-[var(--scratch-preview-w)]' : 'flex flex-col gap-4'}>
      <div>
        <BackLink href="/memberships">Memberships</BackLink>
        <h1 className="mt-3 font-[family-name:var(--font-display)] text-2xl font-extrabold tracking-tight text-[#17151D]">
          New plan
        </h1>
      </div>
      <CirclsHelp lead="Need a hand with this plan?" />

      {cannotCreate ? (
        <RoleNotice>Your role can’t create membership plans — Owners and Managers can.</RoleNotice>
      ) : (
        <Card subtitle="Circls reviews a new plan before it goes live.">
          <form onSubmit={onCreate} className="flex max-w-2xl flex-col gap-2.5">
            <RestoredFormNotice autosave={autosave} unkept="The artwork isn’t kept — pick it again." />
            <MembershipPlanFields
              value={draft}
              onChange={setDraft}
              venues={venues ?? []}
              currencyFor={currencyFor}
            />

            {/* A plan has no id to upload against until it exists, so the file is
                held here and sent immediately after creation. */}
            <PendingPhotosPicker
              photos={artwork}
              onChange={setArtwork}
              max={1}
              title="Plan artwork"
              hint="Optional cover image — JPEG, PNG or WebP, up to 10 MB. Uploaded when the plan is created."
            />

            {err && <p className="text-sm text-red-600">{err}</p>}

            <div className="flex justify-end gap-2">
              <Link href="/memberships" onClick={autosave.clear}>
                <Button type="button" variant="secondary" size="sm">
                  Cancel
                </Button>
              </Link>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={!tenantId || !canPreview}
                title={canPreview ? undefined : 'Enter a plan name to preview'}
                onClick={() => setPreviewOpen((v) => !v)}
              >
                {previewOpen ? 'Hide preview' : 'Preview'}
              </Button>
              <Button
                type="submit"
                size="sm"
                variant="secondary"
                formNoValidate
                disabled={!tenantId || !authed || createMembership.isPending || uploadCover.isPending}
                onClick={() => {
                  asDraft.current = true;
                }}
                title="Keep it to yourself for now — tiers and the rest can follow"
              >
                Save as draft
              </Button>
              <Button
                type="submit"
                size="sm"
                petal="#F9B4D4"
                loading={createMembership.isPending || uploadCover.isPending}
                disabled={!tenantId || !authed}
                onClick={() => {
                  asDraft.current = false;
                }}
              >
                Create plan
              </Button>
            </div>
          </form>
        </Card>
      )}
      <ScratchPreview
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        tenantId={tenantId}
        type="membership"
        listing={scratchMembership({
          tenantId,
          brand: brandOf(tenantId, profile),
          name: draft.name,
          description: draft.description,
          terms: draft.terms,
          tiers: draft.tiers,
          venue: draft.venueId ? venues?.find((v) => v.id === draft.venueId) : null,
          tenantCountry: profile?.country ?? null,
        })}
        files={artwork.map((a) => a.file)}
      />
    </div>
  );
}
