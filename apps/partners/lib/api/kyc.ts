/**
 * Partner-portal hooks for the Phase-11 KYC endpoints.
 *
 *   useKycStatus(tenantId)             — GET  /v1/tenants/:id/kyc
 *   useSubmitKyc(tenantId)             — POST /v1/tenants/:id/kyc
 *   useKycDocuments(tenantId)          — GET  /v1/tenants/:id/kyc/documents
 *   usePresignKycUpload(tenantId)      — POST /v1/tenants/:id/kyc/documents/presign
 *   useRegisterKycDocument(tenantId)   — POST /v1/tenants/:id/kyc/documents
 *
 * Mutations invalidate the matching queries so the UI re-fetches without
 * page reload. Presign + register are exposed as two separate hooks because
 * the actual PUT to the storage backend happens between them (in stub mode
 * the URL is `stub://…` and the PUT is skipped; the UI flags this).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';

export type KycDocType =
  | 'pan'
  | 'gst'
  | 'bank_proof'
  | 'aadhaar_front'
  | 'aadhaar_back'
  | 'address'
  | 'other';

export type KycStatusValue =
  | 'not_started'
  | 'submitted'
  | 'in_review'
  | 'verified'
  | 'rejected';

export interface KycStatusResponse {
  status: KycStatusValue;
  submittedAt: string | null;
  verifiedAt: string | null;
  rejectionReason: string | null;
  razorpayLinkedAccountId: string | null;
}

export interface SubmitKycInput {
  legalName: string;
  email: string;
  phone?: string;
  pan?: string;
  gstin?: string;
  bank?: {
    accountNumber: string;
    ifsc: string;
    holderName: string;
  };
}

export interface SubmitKycResult {
  tenantId: string;
  linkedAccountId: string;
  status: KycStatusValue;
}

export interface KycDocument {
  id: string;
  tenantId: string;
  docType: KycDocType;
  storageKey: string;
  mimeType: string | null;
  sizeBytes: number | null;
  uploadedAt: string;
}

export interface PresignResponse {
  uploadUrl: string;
  storageKey: string;
  headers: Record<string, string>;
  expiresIn: number;
  docType: KycDocType;
  stub: boolean;
}

export interface RegisterDocInput {
  docType: KycDocType;
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
}

export function useKycStatus(tenantId: string | null) {
  return useQuery({
    queryKey: ['kyc-status', tenantId],
    queryFn: () => apiFetch<KycStatusResponse>(`/v1/tenants/${tenantId}/kyc`),
    enabled: Boolean(tenantId),
  });
}

export function useSubmitKyc(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SubmitKycInput) =>
      apiFetch<SubmitKycResult>(`/v1/tenants/${tenantId}/kyc`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['kyc-status', tenantId] });
    },
  });
}

export function useKycDocuments(tenantId: string | null) {
  return useQuery({
    queryKey: ['kyc-documents', tenantId],
    queryFn: () => apiFetch<KycDocument[]>(`/v1/tenants/${tenantId}/kyc/documents`),
    enabled: Boolean(tenantId),
  });
}

export function usePresignKycUpload(tenantId: string) {
  return useMutation({
    mutationFn: (input: { docType: KycDocType; mimeType: string; sizeBytes: number }) =>
      apiFetch<PresignResponse>(`/v1/tenants/${tenantId}/kyc/documents/presign`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
  });
}

export function useRegisterKycDocument(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RegisterDocInput) =>
      apiFetch<KycDocument>(`/v1/tenants/${tenantId}/kyc/documents`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['kyc-documents', tenantId] });
    },
  });
}
