import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { apiFetch } from './client';

/** What a customer has had with the org before. */
export type CustomerKind = 'slot' | 'event' | 'membership';

/**
 * One person the org has recorded before (GET /v1/tenants/:id/customers),
 * for the desk forms' autofill. Built from past bookings and memberships —
 * there is no customer list to maintain.
 */
export interface CustomerSuggestion {
  name: string;
  /** Phone or email as last recorded; null when none was ever captured. */
  contact: string | null;
  /** ISO instant of their most recent booking or membership. */
  lastSeenAt: string;
  timesSeen: number;
  kinds: CustomerKind[];
}

/** The API refuses anything shorter — don't ask it. */
export const CUSTOMER_SEARCH_MIN_QUERY = 2;
const DEBOUNCE_MS = 250;

export async function searchCustomers(
  tenantId: string,
  q: string,
  limit = 8,
): Promise<CustomerSuggestion[]> {
  const params = new URLSearchParams({ q: q.trim(), limit: String(limit) });
  const res = await apiFetch<{ customers: CustomerSuggestion[] }>(
    `/v1/tenants/${tenantId}/customers?${params.toString()}`,
  );
  return res.customers;
}

/**
 * Customers matching what is being typed, a keystroke's pause behind it. The
 * previous answer stays on screen while the next loads, so the list doesn't
 * blink empty between letters. Off (no request, empty list) below the minimum
 * query length or without a tenant.
 */
export function useCustomerSuggestions(tenantId: string, query: string) {
  const q = useDebounced(query.trim(), DEBOUNCE_MS);
  const enabled = Boolean(tenantId) && q.length >= CUSTOMER_SEARCH_MIN_QUERY;
  const result = useQuery({
    queryKey: ['customers', tenantId, q],
    queryFn: () => searchCustomers(tenantId, q),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
  return {
    suggestions: enabled ? (result.data ?? []) : [],
    isLoading: enabled && result.isFetching && result.data === undefined,
    isError: enabled && result.isError,
  };
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}
