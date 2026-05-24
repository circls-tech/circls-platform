import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/lib/firebase/auth_context';
import { apiFetch } from './client';
import type { Arena, Booking, Slot, Tenant, User, Venue } from './types';

export function useMe() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['me', user?.uid],
    enabled: Boolean(user),
    queryFn: () => apiFetch<User>('/v1/me'),
  });
}

export function useMyTenants() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['tenants', user?.uid],
    enabled: Boolean(user),
    queryFn: () => apiFetch<Tenant[]>('/v1/me/tenants'),
  });
}

export function useCreateTenant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; slug: string }) =>
      apiFetch<Tenant>('/v1/tenants', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['tenants'] }),
  });
}

export function useVenues(tenantId: string) {
  return useQuery({
    queryKey: ['venues', tenantId],
    queryFn: () => apiFetch<Venue[]>(`/v1/tenants/${tenantId}/venues`),
  });
}

export function useCreateVenue(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; tzName?: string }) =>
      apiFetch<Venue>(`/v1/tenants/${tenantId}/venues`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['venues', tenantId] }),
  });
}

export function useArenas(venueId: string) {
  return useQuery({
    queryKey: ['arenas', venueId],
    queryFn: () => apiFetch<Arena[]>(`/v1/venues/${venueId}/arenas`),
  });
}

export function useCreateArena(venueId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; sport?: string; slotDurationMin?: number }) =>
      apiFetch<Arena>(`/v1/venues/${venueId}/arenas`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['arenas', venueId] }),
  });
}

export function useArenaSlots(arenaId: string, fromISO: string, toISO: string) {
  return useQuery({
    queryKey: ['slots', arenaId, fromISO, toISO],
    queryFn: () =>
      apiFetch<Slot[]>(
        `/v1/arenas/${arenaId}/slots?from=${encodeURIComponent(fromISO)}&to=${encodeURIComponent(toISO)}`,
      ),
  });
}

export function useArenaBookings(arenaId: string, fromISO: string, toISO: string) {
  return useQuery({
    queryKey: ['bookings', arenaId, fromISO, toISO],
    queryFn: () =>
      apiFetch<Booking[]>(
        `/v1/arenas/${arenaId}/bookings?from=${encodeURIComponent(fromISO)}&to=${encodeURIComponent(toISO)}`,
      ),
  });
}

export function useCreateBooking(arenaId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      tenantId: string;
      arenaId: string;
      startAt: string;
      endAt: string;
      pricePaise?: number;
    }) =>
      apiFetch<Booking>('/v1/bookings', {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify(input),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['bookings', arenaId] }),
  });
}

export function useCancelBooking(arenaId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (bookingId: string) =>
      apiFetch<Booking>(`/v1/bookings/${bookingId}/cancel`, { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['bookings', arenaId] }),
  });
}
