'use client';
import Link from 'next/link';
import { Card } from '@/lib/ui';

export default function SettingsPage() {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-[family-name:var(--font-display)] text-2xl font-extrabold tracking-tight text-[#17151D]">Settings</h1>
        <p className="mt-0.5 font-[family-name:var(--font-accent)] text-xl font-bold text-[#EE5C2B]">
          Your organisation, team and integrations.
        </p>
      </div>
      <Card
        title="Organisation profile"
        subtitle="Your logo, description, contact details, links and address — how customers see you on Circls."
      >
        <Link
          href="/settings/organization"
          className="inline-flex items-center gap-1.5 rounded-[var(--radius)] border-2 border-[#17151D] bg-[#FFB0A3] px-3 py-1.5 text-xs font-bold text-[#17151D] shadow-[3px_3px_0_#17151D] transition-transform hover:-translate-y-0.5"
        >
          Edit organisation profile &rarr;
        </Link>
      </Card>
      <Card
        title="Team"
        subtitle="Invite teammates, change roles, or remove members."
      >
        <Link
          href="/settings/team"
          className="inline-flex items-center gap-1.5 rounded-[var(--radius)] border-2 border-[#17151D] bg-[#FFB0A3] px-3 py-1.5 text-xs font-bold text-[#17151D] shadow-[3px_3px_0_#17151D] transition-transform hover:-translate-y-0.5"
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
          className="inline-flex items-center gap-1.5 rounded-[var(--radius)] border-2 border-[#17151D] bg-[#FFB0A3] px-3 py-1.5 text-xs font-bold text-[#17151D] shadow-[3px_3px_0_#17151D] transition-transform hover:-translate-y-0.5"
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
          className="inline-flex items-center gap-1.5 rounded-[var(--radius)] border-2 border-[#17151D] bg-[#FFB0A3] px-3 py-1.5 text-xs font-bold text-[#17151D] shadow-[3px_3px_0_#17151D] transition-transform hover:-translate-y-0.5"
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
          className="inline-flex items-center gap-1.5 rounded-[var(--radius)] border-2 border-[#17151D] bg-[#FFB0A3] px-3 py-1.5 text-xs font-bold text-[#17151D] shadow-[3px_3px_0_#17151D] transition-transform hover:-translate-y-0.5"
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
          className="inline-flex items-center gap-1.5 rounded-[var(--radius)] border-2 border-[#17151D] bg-[#FFB0A3] px-3 py-1.5 text-xs font-bold text-[#17151D] shadow-[3px_3px_0_#17151D] transition-transform hover:-translate-y-0.5"
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
          className="inline-flex items-center gap-1.5 rounded-[var(--radius)] border-2 border-[#17151D] bg-[#FFB0A3] px-3 py-1.5 text-xs font-bold text-[#17151D] shadow-[3px_3px_0_#17151D] transition-transform hover:-translate-y-0.5"
        >
          Manage webhooks &rarr;
        </Link>
      </Card>
    </div>
  );
}
