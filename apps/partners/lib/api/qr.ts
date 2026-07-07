import { useMutation } from '@tanstack/react-query';
import { apiFetch } from './client';
import type { QrScanResult } from './types';

export interface ValidateQrTicketInput {
  /** The opaque code carried by the customer's QR (or typed in by staff). */
  code: string;
  /** false = peek without spending a scan (server defaults to true). */
  consume?: boolean;
}

/**
 * Door check-in: validate (and by default consume) a scanned QR ticket. Any
 * member of the tenant can scan; codes from other tenants read as not_found.
 * No query invalidation — scan results are transient, shown once to door staff.
 */
export function useValidateQrTicket(tenantId: string) {
  return useMutation({
    mutationFn: (input: ValidateQrTicketInput) =>
      apiFetch<QrScanResult>(`/v1/tenants/${tenantId}/qr-tickets/validate`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
  });
}
