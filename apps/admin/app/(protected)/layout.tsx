'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/firebase/auth_context';
import { apiFetch } from '@/lib/api/client';
import type { MeTenant } from '@/lib/api/types';
import { BrandMark } from '@/components/BrandMark';

const NAV_LINKS = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/tenants', label: 'Tenants' },
  { href: '/payouts', label: 'Payouts' },
  { href: '/listings', label: 'Review queue' },
  { href: '/audit-log', label: 'Audit log' },
  { href: '/support-issues', label: 'Support issues' },
] as const;

function Sidebar({ pathname }: { pathname: string }) {
  return (
    <aside
      className="fixed inset-y-0 left-0 flex w-[220px] flex-col bg-[#0f172a]"
      style={{ zIndex: 40 }}
    >
      <div className="flex h-14 items-center gap-2 px-6">
        <BrandMark className="h-7 w-7" />
        <span className="text-lg font-bold tracking-tight text-white">admin</span>
      </div>
      <nav className="flex flex-1 flex-col gap-0.5 px-3 pt-2">
        {NAV_LINKS.map(({ href, label }) => {
          const isActive = pathname === href || pathname.startsWith(href + '/');
          return (
            <Link
              key={href}
              href={href}
              className={[
                'flex items-center rounded-md px-3 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-white/10 text-white'
                  : 'text-slate-400 hover:bg-white/5 hover:text-white',
              ].join(' ')}
            >
              {label}
            </Link>
          );
        })}
      </nav>
      <div className="h-6" />
    </aside>
  );
}

export default function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const { user, loading, signOut } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  const [memberships, setMemberships] = useState<MeTenant[] | null>(null);
  const [membershipsLoading, setMembershipsLoading] = useState(true);

  useEffect(() => {
    if (!loading && !user) router.replace('/login');
  }, [loading, user, router]);

  useEffect(() => {
    if (!user) return;
    setMembershipsLoading(true);
    apiFetch<MeTenant[]>('/v1/me/tenants')
      .then(setMemberships)
      .catch(() => setMemberships([]))
      .finally(() => setMembershipsLoading(false));
  }, [user]);

  useEffect(() => {
    if (loading || membershipsLoading || memberships === null) return;
    const platformMembership = memberships.find((t) => t.isPlatform);
    if (!platformMembership) {
      void signOut();
      router.replace('/login?error=not_circls_team');
    }
  }, [loading, membershipsLoading, memberships, signOut, router]);

  if (loading || (user && membershipsLoading)) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <span className="block h-6 w-6 animate-spin rounded-full border-2 border-slate-300 border-t-slate-700" />
      </div>
    );
  }
  if (!user) return null;

  return (
    <div className="min-h-screen">
      <Sidebar pathname={pathname} />
      <div className="ml-[220px] flex min-h-screen flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-[#e5e7eb] bg-white px-6">
          <span className="text-sm font-medium text-slate-700">{user.email}</span>
          <button
            type="button"
            onClick={() => void signOut()}
            className="text-sm text-slate-600 hover:text-slate-900"
          >
            Sign out
          </button>
        </header>
        <main className="flex-1 bg-[#f8fafc] p-6">{children}</main>
      </div>
    </div>
  );
}
