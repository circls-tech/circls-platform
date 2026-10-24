'use client';

import { useCommissionWaiver } from '@/lib/api/queries';
import { waiverBanner } from '@/lib/commission_waiver';
import { Card } from '@/lib/ui';

/**
 * The org's commission-free period, on Earnings. The wording lives in
 * lib/commission_waiver.ts (waiverBanner), where it is tested.
 */
export function CommissionWaiverCard({
  tenantId,
  enabled,
}: {
  tenantId: string;
  enabled: boolean;
}) {
  const { data } = useCommissionWaiver(tenantId, enabled);
  // Nothing to say until it loads; a failed fetch shouldn't block Earnings.
  const banner = data ? waiverBanner(data) : null;
  if (!banner) return null;

  return (
    <Card className={banner.highlight ? '!bg-emerald-50' : ''}>
      {banner.title && (
        <p className="font-[family-name:var(--font-display)] text-base font-bold text-[#17151D]">
          {banner.title}
        </p>
      )}
      <p className={`text-sm text-slate-600 ${banner.title ? 'mt-1' : ''}`}>{banner.body}</p>
    </Card>
  );
}
