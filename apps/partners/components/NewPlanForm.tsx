'use client';

import { type FormEvent, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/lib/firebase/auth_context';
import { useCreateMembership, useUploadMembershipCover } from '@/lib/api/memberships';
import { useMyRole, useTenantProfile, useVenues } from '@/lib/api/queries';
import { useVenueCurrencies } from '@/lib/currency';
import { Button, Card } from '@/lib/ui';
import { brandOf, scratchMembership } from '@/lib/api/scratch_listing';
import { ScratchPreview } from '@/components/ScratchPreview';
import { PendingPhotosPicker, type PendingPhoto } from '@/components/PendingPhotos';
import { RoleNotice } from '@/components/RoleNotice';
import { RestoredFormNotice } from '@/components/RestoredFormNotice';
import { useAutosave, useFormAutosave } from '@/lib/use_form_autosave';
import {
  MembershipPlanFields,
  emptyPlanDraft,
  planDraftToInput,
  type MembershipPlanDraft,
} from '@/components/MembershipPlanFields';

/**
 * Creating a membership plan — on /memberships/new and in the onboarding
 * wizard. Sits inside a <FormAutosaveScope>; the page around it leaves room
 * for the docked preview (`xl:pr-[var(--scratch-preview-w,0px)]`).
 */
export function NewPlanForm({
  tenantId,
  onCreated,
  onBack,
}: {
  tenantId: string;
  /** Saved: the plan, whether it was kept as a draft, and why the artwork didn't upload if it didn't. */
  onCreated: (planId: string, saved: { draft: boolean; artworkError: string | null }) => void;
  /** Shows Back in place of Cancel, which leaves for Memberships and forgets the form. */
  onBack?: () => void;
}) {
  // The customer-site preview of the form as it stands (nothing saved).
  const [previewOpen, setPreviewOpen] = useState(false);
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
          // so they can retry the upload from the plan's page.
          onCreated(plan.id, {
            draft: isDraft,
            artworkError: `Plan created, but the artwork failed to upload (${(uploadErr as Error).message}) — add it from the plan's page.`,
          });
          return;
        }
      }
      onCreated(plan.id, { draft: isDraft, artworkError: null });
    } catch (e2) {
      setErr((e2 as Error).message);
    }
  }

  return (
    <>
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
              {onBack ? (
                // Not while saving: the save would land after they'd moved on.
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={createMembership.isPending || uploadCover.isPending}
                  onClick={onBack}
                >
                  Back
                </Button>
              ) : (
                <Link href="/memberships" onClick={autosave.clear}>
                  <Button type="button" variant="secondary" size="sm">
                    Cancel
                  </Button>
                </Link>
              )}
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
    </>
  );
}
