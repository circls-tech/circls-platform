'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/firebase/auth_context';
import { useMyTenants } from '@/lib/api/queries';
import { useQuestionsSummary } from '@/lib/api/questions';
import { OrgProvider, useOrg } from '@/lib/org_context';
import { ContextBar } from '@/components/ContextBar';
import { TermsGate, tenantNeedsTermsGate } from '@/components/TermsGate';
import { OrgSelectorModal } from '@/components/OrgSelectorModal';
import { TimezoneSelect } from '@/components/TimezoneSelect';
import { Button, BrandMark } from '@/lib/ui';

const ORG_SELECTED_KEY = 'circls.orgSelected';

// Each entry carries its own petal pastel for the active highlight + an icon.
const NAV_LINKS = [
  { href: '/dashboard', label: 'Dashboard', petal: '#FFB0A3', icon: 'dashboard' },
  { href: '/activity', label: 'Activity', petal: '#FCE38A', icon: 'activity' },
  { href: '/venues', label: 'Venues', petal: '#BCE3A0', icon: 'venues' },
  { href: '/events', label: 'Events', petal: '#9CE0D4', icon: 'events' },
  { href: '/memberships', label: 'Memberships', petal: '#F9B4D4', icon: 'memberships' },
  { href: '/check-in', label: 'Check-in', petal: '#CDBBF7', icon: 'check-in' },
  { href: '/questions', label: 'Questions', petal: '#A9C9F2', icon: 'questions' },
  { href: '/coupons', label: 'Coupons', petal: '#FFD2A1', icon: 'coupons' },
  { href: '/settings', label: 'Settings', petal: '#FFB0A3', icon: 'settings' },
] as const;


/** Small lucide-style stroke icons for the sidebar nav. */
function NavIcon({ name }: { name: string }) {
  const common = {
    xmlns: 'http://www.w3.org/2000/svg',
    width: 18,
    height: 18,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    className: 'shrink-0',
  };
  switch (name) {
    case 'dashboard':
      return (
        <svg {...common}>
          <rect x="3" y="3" width="7" height="7" rx="1" />
          <rect x="14" y="3" width="7" height="7" rx="1" />
          <rect x="14" y="14" width="7" height="7" rx="1" />
          <rect x="3" y="14" width="7" height="7" rx="1" />
        </svg>
      );
    case 'activity':
      return (
        <svg {...common}>
          <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
        </svg>
      );
    case 'venues':
      return (
        <svg {...common}>
          <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          <polyline points="9 22 9 12 15 12 15 22" />
        </svg>
      );
    case 'events':
      return (
        <svg {...common}>
          <rect x="3" y="4" width="18" height="18" rx="2" />
          <line x1="16" y1="2" x2="16" y2="6" />
          <line x1="8" y1="2" x2="8" y2="6" />
          <line x1="3" y1="10" x2="21" y2="10" />
        </svg>
      );
    case 'memberships':
      return (
        <svg {...common}>
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      );
    case 'check-in':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="10" />
          <path d="m9 12 2 2 4-4" />
        </svg>
      );
    case 'questions':
      return (
        <svg {...common}>
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      );
    case 'coupons':
      return (
        <svg {...common}>
          <path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z" />
          <path d="M13 5v2" />
          <path d="M13 11v2" />
          <path d="M13 17v2" />
        </svg>
      );
    case 'settings':
      return (
        <svg {...common}>
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      );
    default:
      return null;
  }
}

function HamburgerIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}

/** Open-questions count next to the "Questions" nav entry (polled every 60s). */
function OpenQuestionsBadge() {
  const { activeTenantId } = useOrg();
  const { data } = useQuestionsSummary(activeTenantId);
  const openCount = data?.openCount ?? 0;
  if (openCount === 0) return null;
  return (
    <span className="ml-auto inline-flex min-w-[18px] items-center justify-center rounded-full bg-brand-600 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-slate-900">
      {openCount > 99 ? '99+' : openCount}
    </span>
  );
}

function Sidebar({
  pathname,
  open,
  onClose,
}: {
  pathname: string;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <>
      {/* Mobile backdrop */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      <aside
        className={[
          'fixed inset-y-0 left-0 flex w-[220px] flex-col border-r border-slate-900/10 bg-[#FAF3E8] transition-transform duration-200',
          open ? 'translate-x-0' : '-translate-x-full md:translate-x-0',
        ].join(' ')}
        style={{ zIndex: 50 }}
      >
        {/* Brand — the petal C mark alone, centred (same treatment as login). */}
        <div className="flex h-24 items-center justify-center px-4 text-slate-900">
          <BrandMark className="h-16 w-16" />
        </div>

        {/* Nav */}
        <nav className="flex flex-1 flex-col gap-0.5 px-3 pt-2">
          {NAV_LINKS.map(({ href, label, petal, icon }) => {
            const isActive = pathname === href || pathname.startsWith(href + '/');
            return (
              <Link
                key={href}
                href={href}
                onClick={onClose}
                style={isActive ? { backgroundColor: petal } : undefined}
                className={[
                  'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                  isActive
                    ? 'border border-slate-900 text-slate-900 shadow-[2px_2px_0_#0f172a]'
                    : 'border border-transparent text-slate-700 hover:bg-white/60 hover:text-slate-900',
                ].join(' ')}
              >
                <NavIcon name={icon} />
                {label}
                {href === '/questions' && <OpenQuestionsBadge />}
              </Link>
            );
          })}
        </nav>

        {/* Help link at the bottom */}
        <div className="mt-2 border-t border-slate-900/10 px-3 pb-4 pt-2">
          <Link
            href="/help"
            onClick={onClose}
            className={[
              'flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors',
              pathname === '/help'
                ? 'border border-slate-900 bg-white text-slate-900 shadow-[2px_2px_0_#0f172a]'
                : 'border border-transparent text-slate-700 hover:bg-white/60 hover:text-slate-900',
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
    </>
  );
}

/**
 * Blocks the portal behind the Terms & Conditions gate when the active org has
 * not accepted the current version (orgs predating the feature, or a version
 * bump). The Help Centre stays reachable so a blocked user can still read docs.
 */
function GatedContent({ children, pathname }: { children: React.ReactNode; pathname: string }) {
  const { activeTenantId } = useOrg();
  const { data: tenants } = useMyTenants();
  const activeTenant = tenants?.find((t) => t.id === activeTenantId);
  const helpPath = pathname === '/help' || pathname.startsWith('/help/');
  if (tenantNeedsTermsGate(activeTenant) && !helpPath) return <TermsGate />;
  return <>{children}</>;
}

function LayoutWithOrg({ children, pathname }: { children: React.ReactNode; pathname: string }) {
  const [showOrgSelector, setShowOrgSelector] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { data: tenants } = useMyTenants();
  const { signOut } = useAuth();

  // Close sidebar whenever the route changes
  useEffect(() => {
    setSidebarOpen(false);
  }, [pathname]);

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
        <Sidebar pathname={pathname} open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

        {/* Right of sidebar */}
        <div className="md:ml-[220px] flex min-h-screen flex-col">
          {/* Top bar */}
          {/* Taller bar with breathing room. */}
          <header className="sticky top-0 z-30 flex h-24 items-center justify-between gap-4 border-b border-[#e5e7eb] bg-[#FAF3E8] px-8 pt-4">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <button
                type="button"
                onClick={() => setSidebarOpen(true)}
                className="md:hidden -ml-1 shrink-0 rounded p-1 text-slate-600 hover:text-slate-900"
                aria-label="Open navigation"
              >
                <HamburgerIcon />
              </button>
              <ContextBar />
            </div>
            <div className="flex shrink-0 items-center gap-4">
              <TimezoneSelect />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void signOut()}
              >
                Sign out
              </Button>
            </div>
          </header>

          {/* Content area */}
          <main className="flex-1 bg-[#FAF3E8] p-6">
            <GatedContent pathname={pathname}>{children}</GatedContent>
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
