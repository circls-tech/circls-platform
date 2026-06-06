'use client';
import { useOrg } from '@/lib/org_context';
import { Modal } from '@/lib/ui';

interface OrgSelectorModalProps {
  open: boolean;
  onClose: () => void;
}

export function OrgSelectorModal({ open, onClose }: OrgSelectorModalProps) {
  const { tenants, setActiveTenantId, activeTenantId } = useOrg();

  function handleSelect(id: string) {
    setActiveTenantId(id);
    onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title="Select organisation" maxWidth="max-w-sm">
      <div className="flex flex-col gap-2">
        <p className="mb-2 text-sm text-slate-500">
          You belong to multiple organisations. Which one would you like to manage?
        </p>
        {tenants.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => handleSelect(t.id)}
            className={[
              'flex w-full items-center gap-3 rounded-[var(--radius)] border px-4 py-3 text-left text-sm transition-colors',
              t.id === activeTenantId
                ? 'border-brand-600 bg-brand-50 font-medium text-brand-700'
                : 'border-[#e5e7eb] bg-white text-slate-700 hover:bg-slate-50',
            ].join(' ')}
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold uppercase text-slate-600">
              {t.name.slice(0, 2)}
            </span>
            <span className="flex-1 truncate">{t.name}</span>
            {t.id === activeTenantId && (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-brand-600" aria-hidden="true">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
          </button>
        ))}
      </div>
    </Modal>
  );
}
