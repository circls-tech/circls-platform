import { useMutation, useQuery } from '@tanstack/react-query';
import { apiFetch, CHECKOUT_GATEWAYS_HEADER } from './client';

export type QuoteItem =
  | { itemType: 'event'; eventId: string; lines: { tierId: string; quantity: number }[] }
  | { itemType: 'membership'; membershipId: string; membershipTierId?: string }
  | { itemType: 'slot'; slotIds: string[] };

export type QuoteRequest = QuoteItem & { couponCode?: string };

export interface QuoteResponse {
  basePaise: number;
  discountPaise: number;
  discountedBasePaise: number;
  otherChargesPaise: number;
  totalPaise: number;
  /** Split of otherChargesPaise (gateway charge + Circls platform fee) —
   *  feeds the breakdown tooltip. Optional: older API responses lack them. */
  gatewayFeePaise?: number;
  platformFeePaise?: number;
  /** ISO 4217 — 'INR', or 'USD' for US venues. Amounts are its minor units. */
  currency: string;
  coupon: { id: string; code: string; description: string | null } | null;
  error?: string;
}

export interface PublicCoupon {
  code: string;
  description: string | null;
  discountType: 'percent' | 'fixed';
  discountValue: number;
  maxDiscountPaise: number | null;
  minOrderPaise: number | null;
}

export function useCheckoutQuote() {
  return useMutation({
    mutationFn: (req: QuoteRequest) =>
      apiFetch<QuoteResponse>('/v1/consumer/checkout/quote', {
        method: 'POST',
        headers: CHECKOUT_GATEWAYS_HEADER,
        body: JSON.stringify(req),
      }),
  });
}

/** The thing being bought, for the offers list. A venue cart is its slot ids —
 *  the base price (min-order tests) and the venue/arena scope come from them. */
export type PublicCouponItem =
  | { itemType: 'event'; itemId: string }
  | { itemType: 'membership'; itemId: string }
  | { itemType: 'slot'; slotIds: string[] };

function publicCouponsQuery(item: PublicCouponItem): string {
  const p = new URLSearchParams({ itemType: item.itemType });
  if (item.itemType === 'slot') p.set('slotIds', item.slotIds.join(','));
  else p.set('itemId', item.itemId);
  return p.toString();
}

export function usePublicCoupons(item: PublicCouponItem | null) {
  return useQuery({
    queryKey: ['public-coupons', item ? publicCouponsQuery(item) : null],
    enabled: Boolean(item),
    queryFn: () => apiFetch<{ rows: PublicCoupon[] }>(`/v1/consumer/coupons?${publicCouponsQuery(item!)}`),
  });
}
