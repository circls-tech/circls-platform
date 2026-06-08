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

const ROLES: TenantRole[] = ['owner', 'manager', 'staff', 'readonly'];

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
          Invite teammates, change roles, or remove members. Owners can do everything;
          staff can manage bookings.
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
              {ROLES.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </div>
          <button
            type="submit"
            disabled={createInvite.isPending}
            className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {createInvite.isPending ? 'Sending…' : 'Send invitation'}
          </button>
        </form>
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
                  Invited as {inv.role} &middot; expires {dateTimeFmt.format(new Date(inv.expiresAt))}
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => resendInvite.mutate(inv.id)}
                  className="text-xs text-blue-700 hover:underline"
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
                  className="rounded border border-slate-300 px-2 py-1 text-xs"
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>{r}</option>
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
