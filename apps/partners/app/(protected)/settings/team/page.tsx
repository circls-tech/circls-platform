'use client';
import { type FormEvent, useMemo, useState } from 'react';
import { useOrg } from '@/lib/org_context';
import { useTimezone } from '@/lib/timezone_context';
import {
  useCreateInvitation,
  useRemoveMember,
  useResendInvitation,
  useRevokeInvitation,
  useTeamInvitations,
  useTeamMembers,
  useUpdateMemberRole,
} from '@/lib/api/queries';
import type { TenantRole } from '@/lib/api/types';
import { ROLE_INFO, ROLE_ORDER } from '@/lib/roles';

export default function TeamPage() {
  const { activeTenantId } = useOrg();
  const tenantId = activeTenantId ?? '';
  const { resolveTz } = useTimezone();

  const dateTimeFmt = useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, {
        timeZone: resolveTz(),
        dateStyle: 'medium',
        timeStyle: 'short',
      }),
    [resolveTz],
  );
  const dateFmt = useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, {
        timeZone: resolveTz(),
        dateStyle: 'medium',
      }),
    [resolveTz],
  );

  const { data: members } = useTeamMembers(tenantId);
  const { data: pending } = useTeamInvitations(tenantId, 'pending');
  const createInvite = useCreateInvitation(tenantId);
  const resendInvite = useResendInvitation(tenantId);
  const revokeInvite = useRevokeInvitation(tenantId);
  const updateRole = useUpdateMemberRole(tenantId);
  const removeMember = useRemoveMember(tenantId);

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<TenantRole>('manager');
  const [lastToken, setLastToken] = useState<string | null>(null);

  async function handleInvite(e: FormEvent) {
    e.preventDefault();
    const r = await createInvite.mutateAsync({ email: inviteEmail, role: inviteRole });
    setLastToken(r.token);
    setInviteEmail('');
  }

  if (!activeTenantId) {
    return (
      <div className="p-2 text-sm text-slate-500">Select an organization to manage your team.</div>
    );
  }

  return (
    <div className="flex flex-col gap-8 p-2">
      <section>
        <h1 className="text-xl font-semibold">Team</h1>
        <p className="mt-1 text-sm text-slate-500">
          Invite teammates, change roles, or remove members. Each role grants a fixed
          set of rights, described below.
        </p>
      </section>

      <section className="rounded border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
          What each role can do
        </h2>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
          {ROLE_ORDER.map((r) => (
            <div key={r}>
              <dt className="text-sm font-medium text-slate-800">{ROLE_INFO[r].label}</dt>
              <dd className="mt-0.5 text-xs text-slate-500">{ROLE_INFO[r].description}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-xs text-slate-400">
          Choose the least-privileged role that lets someone do their job — you can always
          upgrade them later.
        </p>
      </section>

      <section className="rounded border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Invite a teammate
        </h2>
        <form onSubmit={handleInvite} className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[220px]">
            <label htmlFor="invite-email" className="block text-xs font-medium text-slate-700">
              Email
            </label>
            <input
              id="invite-email"
              type="email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              required
              className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label htmlFor="invite-role" className="block text-xs font-medium text-slate-700">
              Role
            </label>
            <select
              id="invite-role"
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as TenantRole)}
              className="mt-1 rounded border border-slate-300 px-3 py-2 text-sm"
            >
              {ROLE_ORDER.map((r) => (
                <option key={r} value={r}>{ROLE_INFO[r].label}</option>
              ))}
            </select>
          </div>
          <button
            type="submit"
            disabled={createInvite.isPending}
            className="rounded bg-brand-600 px-4 py-2 text-sm font-medium text-slate-900 disabled:opacity-50"
          >
            {createInvite.isPending ? 'Sending…' : 'Send invitation'}
          </button>
        </form>
        <p className="mt-2 text-xs text-slate-500">
          <span className="font-medium">{ROLE_INFO[inviteRole].label}:</span>{' '}
          {ROLE_INFO[inviteRole].description}
        </p>
        {lastToken && (
          <div className="mt-3 rounded border border-amber-200 bg-amber-50 p-3 text-xs">
            <p className="font-medium">Invite link (also emailed):</p>
            <code className="break-all">{`${typeof window !== 'undefined' ? window.location.origin : ''}/invite/${lastToken}`}</code>
          </div>
        )}
      </section>

      <section className="rounded border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Pending invitations
        </h2>
        <ul className="divide-y divide-slate-100">
          {(pending ?? []).map((inv) => (
            <li key={inv.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <div>
                <div className="font-medium">{inv.email}</div>
                <div className="text-xs text-slate-500">
                  Invited as {ROLE_INFO[inv.role].label} &middot; expires {dateTimeFmt.format(new Date(inv.expiresAt))}
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => resendInvite.mutate(inv.id)}
                  className="text-xs text-brand-700 hover:underline"
                >
                  Resend
                </button>
                <button
                  type="button"
                  onClick={() => revokeInvite.mutate(inv.id)}
                  className="text-xs text-red-700 hover:underline"
                >
                  Revoke
                </button>
              </div>
            </li>
          ))}
          {(pending?.length ?? 0) === 0 && (
            <li className="py-2 text-sm text-slate-400">No pending invitations.</li>
          )}
        </ul>
      </section>

      <section className="rounded border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Members
        </h2>
        <ul className="divide-y divide-slate-100">
          {(members ?? []).map((m) => (
            <li key={m.userId} className="flex items-center justify-between gap-3 py-2 text-sm">
              <div>
                <div className="font-medium">{m.email ?? m.displayName ?? m.userId}</div>
                <div className="text-xs text-slate-500">Joined {dateFmt.format(new Date(m.createdAt))}</div>
              </div>
              <div className="flex items-center gap-2">
                <select
                  value={m.role}
                  onChange={(e) =>
                    updateRole.mutate({ userId: m.userId, role: e.target.value as TenantRole })
                  }
                  title={ROLE_INFO[m.role].description}
                  className="rounded border border-slate-300 px-2 py-1 text-xs"
                >
                  {ROLE_ORDER.map((r) => (
                    <option key={r} value={r} title={ROLE_INFO[r].description}>
                      {ROLE_INFO[r].label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => {
                    if (confirm(`Remove ${m.email ?? 'this member'}?`)) {
                      removeMember.mutate(m.userId);
                    }
                  }}
                  className="text-xs text-red-700 hover:underline"
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
