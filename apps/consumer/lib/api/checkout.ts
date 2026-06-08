import { useMutation, useQuery } from '@tanstack/react-query';
import { apiFetch } from './client';

export type QuoteItem =
  | { itemType: 'event'; eventId: string }
  | { itemType: 'membership'; membershipId: string }
  | { itemType: 'slot'; slotIds: string[] };

export type QuoteRequest = QuoteItem & { couponCode?: string };

export interface QuoteResponse {
  basePaise: number;
  discountPaise: number;
  discountedBasePaise: number;
  otherChargesPaise: number;
  totalPaise: number;
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
      apiFetch<QuoteResponse>('/v1/consumer/checkout/quote', { method: 'POST', body: JSON.stringify(req) }),
  });
}

export function usePublicCoupons(item: { itemType: 'event' | 'membership'; itemId: string } | null) {
  return useQuery({
    queryKey: ['public-coupons', item?.itemType, item?.itemId],
    enabled: Boolean(item),
    queryFn: () =>
      apiFetch<{ rows: PublicCoupon[] }>(`/v1/consumer/coupons?itemType=${item!.itemType}&itemId=${item!.itemId}`),
  });
}
