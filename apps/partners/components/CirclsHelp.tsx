'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import { useCirclsSupport, useGrantCirclsSupport } from '@/lib/api/queries';
import { useOrg } from '@/lib/org_context';
import { useTimezone } from '@/lib/timezone_context';
import { useCan } from '@/lib/use_can';
import { Button, Modal } from '@/lib/ui';

/** How long one "Get help from Circls" lets Circls in (GRANT_HOURS in the API). */
export const CIRCLS_HELP_HOURS = 3;

/** "4:30 pm" (or "28 Oct, 4:30 pm" on another day) in the viewing time zone. */
export function useClockTime(): (iso: string) => string {
  const { resolveTz } = useTimezone();
  return useCallback(
    (iso: string) => {
      const d = new Date(iso);
      const tz = resolveTz();
      const sameDay =
        new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d) ===
        new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
      return new Intl.DateTimeFormat(undefined, {
        timeZone: tz,
        hour: 'numeric',
        minute: '2-digit',
        ...(sameDay ? {} : { day: 'numeric', month: 'short' }),
      }).format(d);
    },
    [resolveTz],
  );
}

/**
 * "Get help from Circls": lets Circls's team into the active org's portal
 * for CIRCLS_HELP_HOURS — on the create-event, create-plan and venues pages,
 * in the onboarding wizard once the org exists, and on the Team page, where
 * it can also be ended. Owners and Managers only
 * (it's like inviting someone); hidden on the Circls org and for a Circls
 * super admin who is visiting.
 */
export function CirclsHelp({ lead = 'Need a hand?', onTeamPage = false }: { lead?: string; onTeamPage?: boolean }) {
  const { activeTenantId, tenants } = useOrg();
  const tenant = tenants.find((t) => t.id === activeTenantId);
  const canAsk = useCan('members.invite');
  const show = Boolean(tenant && !tenant.isPlatform && !tenant.superAdminVisit && canAsk);
  const { data } = useCirclsSupport(activeTenantId, show);
  const clock = useClockTime();
  const [open, setOpen] = useState(false);

  if (!show || !activeTenantId) return null;
  const active = data?.active ?? null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-[var(--radius)] border border-violet-200 bg-violet-50 px-4 py-3 text-sm text-violet-900">
      {active ? (
        <>
          <span>
            Circls can work in your portal until <strong>{clock(active.expiresAt)}</strong>.
          </span>
          {!onTeamPage && (
            <Link href="/settings/team" className="font-semibold underline hover:no-underline">
              Manage on the Team page
            </Link>
          )}
        </>
      ) : (
        <>
          <span>
            {lead} Circls can set this up with you, right here in your portal.
          </span>
          <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
            Get help from Circls
          </Button>
        </>
      )}
      <CirclsHelpDialog tenantId={activeTenantId} open={open} onClose={() => setOpen(false)} />
    </div>
  );
}

function CirclsHelpDialog({ tenantId, open, onClose }: { tenantId: string; open: boolean; onClose: () => void }) {
  const grant = useGrantCirclsSupport(tenantId);
  const [note, setNote] = useState('');

  async function handleGrant() {
    try {
      await grant.mutateAsync(note.trim() || null);
      setNote('');
      onClose();
    } catch {
      // Shown below from grant.error.
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Get help from Circls" maxWidth="max-w-md">
      <div className="flex flex-col gap-3 text-sm text-slate-700">
        <p>
          This lets Circls&apos;s team into your partner portal for the next {CIRCLS_HELP_HOURS} hours, so they
          can set things up with you. They can do what a Manager can, apart from your team, API keys, Earnings
          and settings.
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            Everything they do shows in <strong>Settings → Activity Log</strong>, marked Circls.
          </li>
          <li>
            They appear on your <strong>Team</strong> page while they have access, and you can remove them there
            at any time. Otherwise their access ends by itself after {CIRCLS_HELP_HOURS} hours.
          </li>
        </ul>
        <div className="flex flex-col gap-1">
          <label htmlFor="circls-help-note" className="text-xs font-medium uppercase tracking-wide text-[#475569]">
            What do you need help with? (optional)
          </label>
          <textarea
            id="circls-help-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            maxLength={500}
            className="w-full rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-3 py-2 text-sm text-[#0f172a] placeholder:text-[#94a3b8] hover:border-slate-300"
            placeholder="e.g. Set up our Diwali 10K with three ticket tiers"
          />
        </div>
        {grant.error && <p className="text-sm text-red-600">{grant.error.message}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={grant.isPending} onClick={() => void handleGrant()}>
            Let Circls in for {CIRCLS_HELP_HOURS} hours
          </Button>
        </div>
      </div>
    </Modal>
  );
}
