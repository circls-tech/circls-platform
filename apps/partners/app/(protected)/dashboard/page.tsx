'use client';
import { useMe } from '@/lib/api/queries';

export default function DashboardPage() {
  const { data: me, isLoading, error } = useMe();
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">Dashboard</h1>
      {isLoading && <p className="text-gray-500">Loading your profile…</p>}
      {error && <p className="text-red-600">Couldn’t load profile: {(error as Error).message}</p>}
      {me && (
        <div className="rounded border border-gray-200 bg-white p-4">
          <p className="text-sm text-gray-500">Signed in as</p>
          <p className="font-medium">{me.phoneE164 ?? me.email ?? me.id}</p>
          <p className="mt-2 text-xs text-gray-400">user id: {me.id}</p>
        </div>
      )}
    </div>
  );
}
