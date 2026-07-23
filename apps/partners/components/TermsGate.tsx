'use client';

import { useState } from 'react';
import { useAcceptTerms, useMyTenants } from '@/lib/api/queries';
import { useOrg } from '@/lib/org_context';
import {
  CURRENT_TERMS_VERSION,
  needsTermsAcceptance,
  type TermsCountry,
} from '@/lib/terms/constants';
import { Button, Card } from '@/lib/ui';
import { TermsAcceptance } from '@/components/TermsAcceptance';

/**
 * Full-page blocker shown when the active org has not accepted the current
 * Partner Terms & Conditions (orgs that predate the feature, or a version
 * bump). Owners/managers accept in place; other roles are told who can.
 * The server enforces the same rule on create endpoints — this gate is UX,
 * not the security boundary.
 */
export function TermsGate() {
  const { activeTenantId } = useOrg();
  const { data: tenants } = useMyTenants();
  const tenant = tenants?.find((t) => t.id === activeTenantId);
  const acceptTerms = useAcceptTerms(activeTenantId ?? '');

  const [country, setCountry] = useState<TermsCountry>('India');
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!tenant) return null;

  async function handleAccept() {
    setError(null);
    try {
      await acceptTerms.mutateAsync({ version: CURRENT_TERMS_VERSION, country });
    } catch (err) {
      const msg = (err as Error).message ?? 'Could not record acceptance.';
      setError(
        msg.includes('forbidden')
          ? 'Only an owner or manager can accept on behalf of the organisation — please ask one to sign in and accept.'
          : msg,
      );
    }
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 py-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">
          Terms &amp; Conditions
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          {tenant.termsAcceptedAt
            ? `Our Partner Terms & Conditions have been updated. ${tenant.name} needs to accept the new version before continuing.`
            : `Before ${tenant.name} can continue using the Partner Portal, an owner or manager needs to accept the Partner Terms & Conditions.`}
        </p>
      </div>

      <Card>
        <div className="flex flex-col gap-5">
          <TermsAcceptance
            country={country}
            onCountryChange={setCountry}
            agreed={agreed}
            onAgreedChange={setAgreed}
          />

          {error && <p className="text-sm text-red-600">{error}</p>}

          <div className="flex justify-end">
            <Button
              variant="primary"
              onClick={() => void handleAccept()}
              loading={acceptTerms.isPending}
              disabled={!agreed}
            >
              Accept &amp; continue
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

/** Whether the gate should replace the portal content for this tenant. */
export function tenantNeedsTermsGate(
  tenant: { termsVersion?: string | null; termsAcceptedAt?: string | null; isPlatform?: boolean } | undefined,
): boolean {
  if (!tenant) return false;
  return needsTermsAcceptance({
    termsVersion: tenant.termsVersion ?? null,
    termsAcceptedAt: tenant.termsAcceptedAt ?? null,
    isPlatform: tenant.isPlatform ?? false,
  });
}
