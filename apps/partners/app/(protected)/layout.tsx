'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useAuth } from '@/lib/firebase/auth_context';
import { useMyTenants } from '@/lib/api/queries';
import { OrgProvider } from '@/lib/org_context';
import { ContextBar } from '@/components/ContextBar';
import { Button, BrandMark } from '@/lib/ui';

const NAV_LINKS = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/venues', label: 'Venues' },
  { href: '/settings', label: 'Settings' },
] as const;

function Sidebar({ pathname }: { pathname: string }) {
  return (
    <aside
      className="fixed inset-y-0 left-0 flex w-[220px] flex-col bg-[#0f172a]"
      style={{ zIndex: 40 }}
    >
      {/* Wordmark */}
      <div className="flex h-14 items-center gap-2 px-6">
        <BrandMark className="h-7 w-7" />
        <span className="text-lg font-bold tracking-tight text-white">circls</span>
      </div>

      {/* Nav */}
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

      {/* Bottom spacer */}
      <div className="h-6" />
    </aside>
  );
}

export default function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const { user, loading, signOut } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const { data: tenants, isLoading: tenantsLoading } = useMyTenants();

  useEffect(() => {
    if (!loading && !user) router.replace('/login');
  }, [loading, user, router]);

  // A signed-in user with no org belongs in the onboarding wizard (self-serve
  // org creation). Allow them to sit on /onboarding or /no-tenants; bounce them
  // there from anywhere else.
  const tenantLess = (tenants?.length ?? 0) === 0;
  const onboardingPaths = pathname === '/onboarding' || pathname === '/no-tenants';
  useEffect(() => {
    if (!loading && user && !tenantsLoading && tenantLess && !onboardingPaths) {
      router.replace('/onboarding');
    }
  }, [loading, user, tenantsLoading, tenantLess, onboardingPaths, router]);

  if (loading || (user && tenantsLoading)) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <span className="block h-6 w-6 animate-spin rounded-full border-2 border-slate-300 border-t-slate-700" />
      </div>
    );
  }
  if (!user) return null;

  // No-tenants page: render without chrome (Sidebar/ContextBar assume a
  // selected tenant).
  if (pathname === '/no-tenants') return <>{children}</>;

  // Onboarding wizard: full-screen, no sidebar, but wrapped in OrgProvider —
  // Step 1 calls useOrg().setActiveTenantId after creating the org. OrgProvider
  // tolerates zero tenants (it no-ops until tenants load).
  if (pathname === '/onboarding') return <OrgProvider>{children}</OrgProvider>;

  return (
    <OrgProvider>
      <div className="min-h-screen">
        {/* Left sidebar */}
        <Sidebar pathname={pathname} />

        {/* Right of sidebar */}
        <div className="ml-[220px] flex min-h-screen flex-col">
          {/* Top bar */}
          <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-[#e5e7eb] bg-white px-6">
            <ContextBar />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void signOut()}
            >
              Sign out
            </Button>
          </header>

          {/* Content area */}
          <main className="flex-1 bg-[#f8fafc] p-6">
            {children}
          </main>
        </div>
      </div>
    </OrgProvider>
  );
}
