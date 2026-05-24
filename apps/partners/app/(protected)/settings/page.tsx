'use client';
import { Card } from '@/lib/ui';

export default function SettingsPage() {
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold text-[#0f172a]">Settings</h1>
      <Card title="Settings" subtitle="Organization and account configuration.">
        <p className="text-sm text-slate-500">Coming soon.</p>
      </Card>
    </div>
  );
}
