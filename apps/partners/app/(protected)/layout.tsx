'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/firebase/auth_context';
import { useMyTenants } from '@/lib/api/queries';
import { OrgProvider } from '@/lib/org_context';
import { ContextBar } from '@/components/ContextBar';
import { OrgSelectorModal } from '@/components/OrgSelectorModal';
import { Button, BrandMark } from '@/lib/ui';

const ORG_SELECTED_KEY = 'circls.orgSelected';

const NAV_LINKS = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/venues', label: 'Venues' },
  { href: '/events', label: 'Events' },
  { href: '/memberships', label: 'Memberships' },
  { href: '/coupons', label: 'Coupons' },
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

      {/* Help link at the bottom */}
      <div className="px-3 pb-4 pt-2 border-t border-white/10 mt-2">
        <Link
          href="/help"
          className={[
            'flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors',
            pathname === '/help'
              ? 'bg-white/10 text-white'
              : 'text-slate-400 hover:bg-white/5 hover:text-white',
          ].join(' ')}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          Help
        </Link>
      </div>
    </aside>
  );
}

function LayoutWithOrg({ children, pathname }: { children: React.ReactNode; pathname: string }) {
  const [showOrgSelector, setShowOrgSelector] = useState(false);
  const { data: tenants } = useMyTenants();
  const { signOut } = useAuth();

  // Show org selector modal once per session when user has multiple orgs.
  useEffect(() => {
    if (!tenants || tenants.length <= 1) return;
    const alreadySelected = sessionStorage.getItem(ORG_SELECTED_KEY);
    if (!alreadySelected) {
      setShowOrgSelector(true);
      sessionStorage.setItem(ORG_SELECTED_KEY, '1');
    }
  }, [tenants]);

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

      <OrgSelectorModal
        open={showOrgSelector}
        onClose={() => setShowOrgSelector(false)}
      />
    </OrgProvider>
  );
}

export default function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
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

  return <LayoutWithOrg pathname={pathname}>{children}</LayoutWithOrg>;
}
