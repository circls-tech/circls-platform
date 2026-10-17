'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/firebase/auth_context';
import { apiFetch } from '@/lib/api/client';
import type { MeTenant } from '@/lib/api/types';
import { BrandMark } from '@/components/BrandMark';

// Each entry carries its own petal pastel for the active highlight + an icon,
// mirroring the partner portal sidebar so both consoles read as one product.
const NAV_LINKS = [
  { href: '/dashboard', label: 'Dashboard', petal: '#FFB0A3', icon: 'dashboard' },
  { href: '/tenants', label: 'Tenants', petal: '#FCE38A', icon: 'tenants' },
  { href: '/users', label: 'Consumers', petal: '#BCE3A0', icon: 'consumers' },
  { href: '/partner-users', label: 'Partner users', petal: '#9CE0D4', icon: 'partner-users' },
  { href: '/payouts', label: 'Payouts', petal: '#F9B4D4', icon: 'payouts' },
  { href: '/payments', label: 'Payments', petal: '#CDBBF7', icon: 'payments' },
  { href: '/listings', label: 'Review queue', petal: '#A9C9F2', icon: 'review' },
  { href: '/coupons', label: 'Coupons', petal: '#FFD2A1', icon: 'coupons' },
  { href: '/audit-log', label: 'Audit log', petal: '#FFB0A3', icon: 'audit' },
  { href: '/support-issues', label: 'Support issues', petal: '#FCE38A', icon: 'support' },
  { href: '/questions', label: 'Questions', petal: '#BCE3A0', icon: 'questions' },
] as const;

type NavIconName = (typeof NAV_LINKS)[number]['icon'];

/** Small lucide-style stroke icons for the sidebar nav. */
function NavIcon({ name }: { name: NavIconName }) {
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
    case 'tenants':
      return (
        <svg {...common}>
          <rect x="4" y="2" width="16" height="20" rx="2" />
          <path d="M9 22v-4h6v4" />
          <path d="M8 6h.01M16 6h.01M12 6h.01M12 10h.01M8 10h.01M16 10h.01M12 14h.01M8 14h.01M16 14h.01" />
        </svg>
      );
    case 'consumers':
      return (
        <svg {...common}>
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      );
    case 'partner-users':
      return (
        <svg {...common}>
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <polyline points="16 11 18 13 22 9" />
        </svg>
      );
    case 'payouts':
      return (
        <svg {...common}>
          <rect x="2" y="6" width="20" height="12" rx="2" />
          <circle cx="12" cy="12" r="2" />
          <path d="M6 12h.01M18 12h.01" />
        </svg>
      );
    case 'payments':
      return (
        <svg {...common}>
          <rect x="2" y="5" width="20" height="14" rx="2" />
          <line x1="2" y1="10" x2="22" y2="10" />
        </svg>
      );
    case 'review':
      return (
        <svg {...common}>
          <rect x="8" y="2" width="8" height="4" rx="1" />
          <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
          <path d="m9 14 2 2 4-4" />
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
    case 'audit':
      return (
        <svg {...common}>
          <path d="M8 21h12a2 2 0 0 0 2-2v-2H10v2a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v3h4" />
          <path d="M19 17V5a2 2 0 0 0-2-2H4" />
          <path d="M15 8h-5M15 12h-5" />
        </svg>
      );
    case 'support':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="10" />
          <circle cx="12" cy="12" r="4" />
          <line x1="4.93" y1="4.93" x2="9.17" y2="9.17" />
          <line x1="14.83" y1="14.83" x2="19.07" y2="19.07" />
          <line x1="14.83" y1="9.17" x2="19.07" y2="4.93" />
          <line x1="4.93" y1="19.07" x2="9.17" y2="14.83" />
        </svg>
      );
    case 'questions':
      return (
        <svg {...common}>
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
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

/** Avatar + email for the signed-in admin, pinned under the nav. */
function SidebarUserCard({ email, onSignOut }: { email: string; onSignOut: () => void }) {
  const initial = email.trim().charAt(0).toUpperCase() || '?';
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
          <p className="truncate text-sm font-bold text-slate-900">{email}</p>
          <p className="text-xs text-slate-500">circls team</p>
        </div>
      </div>
      {/* Sign out — salmon petal pill with the comic border, as in the partner portal. */}
      <button
        type="button"
        onClick={onSignOut}
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
  email,
  onSignOut,
}: {
  pathname: string;
  open: boolean;
  onClose: () => void;
  email: string;
  onSignOut: () => void;
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
          'fixed inset-y-0 left-0 flex w-[220px] flex-col border-r-2 border-slate-900 bg-[#FAF3E8] transition-transform duration-200',
          open ? 'translate-x-0' : '-translate-x-full md:translate-x-0',
        ].join(' ')}
        style={{ zIndex: 50 }}
      >
        {/* Brand — the petal C mark with a small "admin" tag beneath it. */}
        <div className="flex h-24 flex-col items-center justify-center gap-1 px-4 text-slate-900">
          <BrandMark className="h-14 w-14" />
          <span className="font-[family-name:var(--font-accent)] text-base leading-none text-slate-700">
            admin
          </span>
        </div>

        {/* Nav */}
        <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-3 pt-2">
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
              </Link>
            );
          })}
        </nav>

        {/* Signed-in admin, pinned at the bottom. */}
        <SidebarUserCard email={email} onSignOut={onSignOut} />
      </aside>
    </>
  );
}

export default function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const { user, loading, signOut } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const [memberships, setMemberships] = useState<MeTenant[] | null>(null);
  const [membershipsLoading, setMembershipsLoading] = useState(true);

  // Close sidebar whenever the route changes
  useEffect(() => {
    setSidebarOpen(false);
  }, [pathname]);

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

  const section = NAV_LINKS.find(
    ({ href }) => pathname === href || pathname.startsWith(href + '/'),
  );

  return (
    <div className="min-h-screen">
      <Sidebar
        pathname={pathname}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        email={user.email ?? ''}
        onSignOut={() => void signOut()}
      />
      <div className="md:ml-[220px] flex min-h-screen flex-col">
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between gap-3 border-b-2 border-slate-900 bg-[#FAF3E8] px-4 sm:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              className="md:hidden -ml-1 shrink-0 rounded p-1 text-slate-600 hover:text-slate-900"
              aria-label="Open navigation"
            >
              <HamburgerIcon />
            </button>
            {section && (
              <span className="flex items-center gap-2 text-slate-900">
                <span
                  aria-hidden
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border-2 border-slate-900"
                  style={{ backgroundColor: section.petal }}
                >
                  <NavIcon name={section.icon} />
                </span>
                <span className="font-[family-name:var(--font-display)] text-base font-bold tracking-tight">
                  {section.label}
                </span>
              </span>
            )}
          </div>
          <span className="hidden truncate text-sm text-slate-600 sm:block">{user.email}</span>
        </header>
        <main className="flex-1 bg-[#FAF3E8] p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}
