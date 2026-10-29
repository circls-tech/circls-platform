'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/firebase/auth_context';
import { useMe, useMyRole, useMyTenants } from '@/lib/api/queries';
import { useQuestionsSummary } from '@/lib/api/questions';
import { OrgProvider, useOrg } from '@/lib/org_context';
import { useCan } from '@/lib/use_can';
import { ContextBar } from '@/components/ContextBar';
import { NavIcon } from '@/components/NavIcon';
import { EmailVerificationBanner } from '@/components/EmailVerificationBanner';
import { SuperAdminBanner } from '@/components/SuperAdminBanner';
import { SuspendedBanner } from '@/components/SuspendedBanner';
import { TermsGate, tenantNeedsTermsGate } from '@/components/TermsGate';
import { OrgSelectorModal } from '@/components/OrgSelectorModal';
import { PlatformFeedback } from '@/components/PlatformFeedback';
import { TimezoneSelect } from '@/components/TimezoneSelect';
import { BrandMark } from '@/lib/ui';

const ORG_SELECTED_KEY = 'circls.orgSelected';

// Each entry carries its own petal pastel for the active highlight + an icon.
// `cap`, where present, hides the link from members who don't hold it — the
// page itself refuses them anyway, so offering it would only be a dead end.
const NAV_LINKS = [
  { href: '/dashboard', label: 'Dashboard', petal: '#FFB0A3', icon: 'dashboard' },
  { href: '/activity', label: 'Activity', petal: '#FCE38A', icon: 'activity' },
  { href: '/earnings', label: 'Earnings', petal: '#BCE3A0', icon: 'earnings', cap: 'financials.read' },
  { href: '/venues', label: 'Venues', petal: '#BCE3A0', icon: 'venues' },
  { href: '/events', label: 'Events', petal: '#9CE0D4', icon: 'events' },
  { href: '/memberships', label: 'Memberships', petal: '#F9B4D4', icon: 'memberships' },
  { href: '/check-in', label: 'Check-in', petal: '#CDBBF7', icon: 'check-in' },
  { href: '/questions', label: 'Questions', petal: '#A9C9F2', icon: 'questions' },
  { href: '/coupons', label: 'Coupons', petal: '#FFD2A1', icon: 'coupons' },
  { href: '/settings', label: 'Settings', petal: '#FFB0A3', icon: 'settings' },
  { href: '/help', label: 'Help', petal: '#FCE38A', icon: 'help' },
] as const;

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

const ROLE_LABELS: Record<string, string> = {
  owner: 'Owner',
  manager: 'Manager',
  staff: 'Staff',
  readonly: 'Read-only',
};

/** Avatar + name + role for the signed-in member, pinned under the nav. */
function SidebarUserCard() {
  const { signOut } = useAuth();
  const { data: me } = useMe();
  const { activeTenantId, tenants } = useOrg();
  const { role } = useMyRole(activeTenantId);
  const visiting = tenants.find((t) => t.id === activeTenantId)?.superAdminVisit ?? false;
  const name = me?.displayName ?? me?.email ?? '…';
  const initial = name.trim().charAt(0).toUpperCase() || '?';
  return (
    <div className="mt-2 border-t border-slate-900/10 px-4 pb-5 pt-4">
      <div className="flex items-center gap-3">
        <span
          aria-hidden
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-2 border-slate-900 bg-[#CDBBF7] font-bold text-slate-900"
        >
          {initial}
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-bold text-slate-900">{name}</p>
          {visiting ? (
            <p className="text-xs text-slate-500">Circls super admin</p>
          ) : (
            role && <p className="text-xs text-slate-500">{ROLE_LABELS[role] ?? role}</p>
          )}
        </div>
      </div>
      {/* Sign out — salmon petal pill with the comic border, per the mock. */}
      <button
        type="button"
        onClick={() => void signOut()}
        className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border-2 border-slate-900 bg-[#FFB0A3] px-3 py-2 text-sm font-bold text-slate-900 shadow-[2px_2px_0_#0f172a] transition-transform hover:-translate-y-0.5"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
          <polyline points="16 17 21 12 16 7" />
          <line x1="21" y1="12" x2="9" y2="12" />
        </svg>
        Sign out
      </button>
    </div>
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
  // Gates for the `cap` entries in NAV_LINKS. Resolved here, one hook call per
  // capability, because a hook can't be called inside the map below. False
  // until the member's role loads, so a link appears once it's known rather
  // than flashing and vanishing.
  const caps: Record<'financials.read', boolean> = {
    'financials.read': useCan('financials.read'),
  };
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
          'fixed inset-y-0 left-0 flex w-[220px] flex-col border-r-2 border-slate-900 bg-[#FAF3E8] transition-transform duration-200',
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
          {NAV_LINKS.filter((link) => !('cap' in link) || caps[link.cap]).map(({ href, label, petal, icon }) => {
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

        {/* Signed-in user, pinned at the bottom. */}
        <SidebarUserCard />
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
  return (
    <>
      {children}
      {/* The platform survey nudge, once the org is past the Terms gate. */}
      <PlatformFeedback />
    </>
  );
}

function LayoutWithOrg({ children, pathname }: { children: React.ReactNode; pathname: string }) {
  const [showOrgSelector, setShowOrgSelector] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { data: tenants } = useMyTenants();

  // Close sidebar whenever the route changes
  useEffect(() => {
    setSidebarOpen(false);
  }, [pathname]);

  // Show org selector modal once per session when user has multiple orgs. An
  // org a super admin opened doesn't count: they just picked it.
  useEffect(() => {
    if (!tenants || tenants.filter((t) => !t.superAdminVisit).length <= 1) return;
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
          <header className="sticky top-0 z-30 flex h-16 items-center justify-between gap-3 border-b-2 border-slate-900 bg-[#FAF3E8] px-4 pt-1 sm:h-20 sm:px-8 sm:pt-2">
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
            <div className="hidden shrink-0 items-center sm:flex">
              <TimezoneSelect />
            </div>
          </header>

          <EmailVerificationBanner />
          <SuspendedBanner />
          <SuperAdminBanner />

          {/* Content area */}
          <main className="flex-1 bg-[#FAF3E8] p-4 sm:p-6">
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
  if (pathname === '/onboarding')
    return (
      <OrgProvider>
        <EmailVerificationBanner />
        {children}
      </OrgProvider>
    );

  return <LayoutWithOrg pathname={pathname}>{children}</LayoutWithOrg>;
}
