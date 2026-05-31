'use client';
import Link from 'next/link';
import { Card } from '@/lib/ui';

export default function SettingsPage() {
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold text-[#0f172a]">Settings</h1>
      <Card title="Settings" subtitle="Organization and account configuration.">
        <p className="text-sm text-slate-500">Coming soon.</p>
      </Card>
      <Card
        title="Team"
        subtitle="Invite teammates, change roles, or remove members."
      >
        <Link
          href="/settings/team"
          className="inline-flex items-center gap-1.5 rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition-colors hover:bg-slate-50"
        >
          Manage team &rarr;
        </Link>
      </Card>
      <Card
        title="Activity Log"
        subtitle="Review a full audit trail of changes made within your organization."
      >
        <Link
          href="/settings/audit-log"
          className="inline-flex items-center gap-1.5 rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition-colors hover:bg-slate-50"
        >
          View activity log &rarr;
        </Link>
      </Card>
      <Card
        title="Notifications"
        subtitle="Outbound SMS, email and WhatsApp messages dispatched for this organization."
      >
        <Link
          href="/settings/notifications"
          className="inline-flex items-center gap-1.5 rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition-colors hover:bg-slate-50"
        >
          View notifications &rarr;
        </Link>
      </Card>
      <Card
        title="Memberships"
        subtitle="Create time-bound passes your customers can purchase."
      >
        <Link
          href="/memberships"
          className="inline-flex items-center gap-1.5 rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition-colors hover:bg-slate-50"
        >
          Manage memberships &rarr;
        </Link>
      </Card>
      <Card
        title="API keys"
        subtitle="Issue and revoke Circls API keys for aggregator integrations."
      >
        <Link
          href="/settings/api-keys"
          className="inline-flex items-center gap-1.5 rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition-colors hover:bg-slate-50"
        >
          Manage API keys &rarr;
        </Link>
      </Card>
      <Card
        title="Outbound webhooks"
        subtitle="Subscribe a URL to booking and payment events for real-time syncing."
      >
        <Link
          href="/settings/webhooks"
          className="inline-flex items-center gap-1.5 rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition-colors hover:bg-slate-50"
        >
          Manage webhooks &rarr;
        </Link>
      </Card>
    </div>
  );
}
