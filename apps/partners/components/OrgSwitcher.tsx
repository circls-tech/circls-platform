'use client';
import { useOrg } from '@/lib/org_context';

export function OrgSwitcher() {
  const { activeTenantId, setActiveTenantId, tenants } = useOrg();

  if (tenants.length === 0) {
    return (
      <span className="text-sm text-slate-400">No organization</span>
    );
  }

  const active = tenants.find((t) => t.id === activeTenantId) ?? tenants[0];

  return (
    <details className="relative">
      <summary
        className="flex cursor-pointer list-none items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 select-none"
        style={{ outline: 'none' }}
      >
        <span className="max-w-[160px] truncate">{active.name}</span>
        {/* chevron-down */}
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-slate-400"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </summary>

      {/* dropdown */}
      <div className="absolute left-0 top-full z-50 mt-1 w-52 rounded-md border border-[#e5e7eb] bg-white shadow-md">
        <ul className="py-1">
          {tenants.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => {
                  setActiveTenantId(t.id);
                  // close the <details>
                  (document.activeElement as HTMLElement)?.blur();
                }}
                className={[
                  'flex w-full items-center gap-2 px-4 py-2 text-left text-sm transition-colors',
                  t.id === activeTenantId
                    ? 'bg-slate-50 font-medium text-slate-900'
                    : 'text-slate-700 hover:bg-slate-50',
                ].join(' ')}
              >
                <span className="flex-1 truncate">{t.name}</span>
                {t.id === activeTenantId && (
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="text-brand-600 shrink-0"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}
