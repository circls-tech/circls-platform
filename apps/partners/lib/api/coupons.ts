import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';

export type CouponScopeType = 'org' | 'venue' | 'event' | 'arena' | 'membership';
export type CouponDiscountType = 'percent' | 'fixed';
export type CouponVisibility = 'public' | 'private';
export type CouponStatus = 'active' | 'paused' | 'expired';

export interface Coupon {
  id: string;
  ownerType: 'platform' | 'tenant';
  tenantId: string | null;
  code: string;
  description: string | null;
  scopeType: CouponScopeType;
  scopeId: string | null;
  discountType: CouponDiscountType;
  discountValue: number;
  maxDiscountPaise: number | null;
  minOrderPaise: number | null;
  visibility: CouponVisibility;
  validFrom: string | null;
  validUntil: string | null;
  maxRedemptions: number | null;
  perUserLimit: number | null;
  redeemedCount: number;
  status: CouponStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCouponInput {
  code: string;
  description?: string;
  scopeType: CouponScopeType;
  scopeId?: string;
  discountType: CouponDiscountType;
  discountValue: number;
  maxDiscountPaise?: number;
  minOrderPaise?: number;
  visibility?: CouponVisibility;
  validFrom?: string;
  validUntil?: string;
  maxRedemptions?: number;
  perUserLimit?: number;
}

export interface UpdateCouponPatch {
  description?: string | null;
  minOrderPaise?: number | null;
  maxDiscountPaise?: number | null;
  visibility?: CouponVisibility;
  validFrom?: string | null;
  validUntil?: string | null;
  maxRedemptions?: number | null;
  perUserLimit?: number | null;
  status?: CouponStatus;
}

export function useTenantCoupons(tenantId: string) {
  return useQuery({
    queryKey: ['tenant-coupons', tenantId],
    queryFn: () => apiFetch<Coupon[]>(`/v1/tenants/${tenantId}/coupons`),
    enabled: Boolean(tenantId),
  });
}

export function useCreateCoupon(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCouponInput) =>
      apiFetch<Coupon>(`/v1/tenants/${tenantId}/coupons`, { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['tenant-coupons', tenantId] }),
  });
}

export function useUpdateCoupon(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ couponId, patch }: { couponId: string; patch: UpdateCouponPatch }) =>
      apiFetch<Coupon>(`/v1/tenants/${tenantId}/coupons/${couponId}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['tenant-coupons', tenantId] }),
  });
}

export function useDeleteCoupon(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (couponId: string) =>
      apiFetch<void>(`/v1/tenants/${tenantId}/coupons/${couponId}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['tenant-coupons', tenantId] }),
  });
}
