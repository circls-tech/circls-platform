'use client';
import Link from 'next/link';
import { type FormEvent, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useCreateTenant, useMe, useMyTenants } from '@/lib/api/queries';

export default function DashboardPage() {
  const router = useRouter();
  const { data: me } = useMe();
  const { data: tenants, isLoading } = useMyTenants();
  const createTenant = useCreateTenant();

  // Redirect new users who have no org yet to the onboarding wizard.
  useEffect(() => {
    if (!isLoading && tenants !== undefined && tenants.length === 0) {
      router.replace('/onboarding');
    }
  }, [isLoading, tenants, router]);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [err, setErr] = useState<string | null>(null);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    try {
      await createTenant.mutateAsync({ name, slug });
      setName('');
      setSlug('');
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Dashboard</h1>
        {me && (
          <p className="text-sm text-gray-500">Signed in as {me.phoneE164 ?? me.email ?? me.id}</p>
        )}
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="font-medium">Your tenants</h2>
        {isLoading && <p className="text-gray-500">Loading…</p>}
        <ul className="flex flex-col gap-2">
          {tenants?.map((t) => (
            <li key={t.id}>
              <Link
                href={`/tenants/${t.id}`}
                className="block rounded border border-gray-200 bg-white p-3 hover:border-blue-400"
              >
                <span className="font-medium">{t.name}</span>
                <span className="ml-2 text-xs text-gray-400">
                  /{t.slug} · KYC {t.kycStatus}
                </span>
              </Link>
            </li>
          ))}
          {tenants?.length === 0 && (
            <p className="text-sm text-gray-500">No tenants yet — create one below.</p>
          )}
        </ul>
      </section>

      <form
        onSubmit={onCreate}
        className="flex max-w-md flex-col gap-2 rounded border border-gray-200 bg-white p-4"
      >
        <h2 className="font-medium">Create a tenant</h2>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Business name"
          className="rounded border border-gray-300 px-3 py-2"
        />
        <input
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          placeholder="slug-like-this"
          className="rounded border border-gray-300 px-3 py-2"
        />
        <button
          type="submit"
          disabled={createTenant.isPending}
          className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50"
        >
          {createTenant.isPending ? 'Creating…' : 'Create tenant'}
        </button>
        {err && <p className="text-sm text-red-600">{err}</p>}
      </form>
    </div>
  );
}
