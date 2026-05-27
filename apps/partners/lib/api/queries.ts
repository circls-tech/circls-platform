import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/lib/firebase/auth_context';
import { apiFetch } from './client';
import type { Arena, Booking, BookingDetail, BookingListItem, Slot, Tenant, User, Venue } from './types';

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

// ── Schedule-builder hooks ────────────────────────────────────────────────────

export interface ReleaseCell {
  dayOfWeek: number;      // 0 (Sun) – 6 (Sat)
  startTimeMin: number;   // minutes from midnight in venue tz
  durationMin: number;
  price?: number | null;  // paise
  blocked?: boolean;
}

export interface ReleaseInput {
  startDate: string;        // 'YYYY-MM-DD'
  endDate: string;          // 'YYYY-MM-DD'
  quantizationMin: number;
  cells: ReleaseCell[];
}

export interface ReleaseResult {
  created: number;
  skipped: number;
}

export function useReleaseSlots(arenaId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ReleaseInput) =>
      apiFetch<ReleaseResult>(`/v1/arenas/${arenaId}/slots/release`, {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify(input),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['slots', arenaId] }),
  });
}

export interface BulkSlotPatch {
  slotIds: string[];
  price?: number;
  blocked?: boolean;
}

export function useBulkSlots() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: BulkSlotPatch) =>
      apiFetch<Slot[]>('/v1/slots/bulk', {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['slots'] }),
  });
}

// ── Reception hooks ───────────────────────────────────────────────────────────

export interface BookingCustomer {
  name: string;
  contact: string;
  note?: string;
}

export interface BookSlotsInput {
  slotIds: string[];
  customer: BookingCustomer;
}

export function useBookSlots(arenaId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: BookSlotsInput) =>
      apiFetch<Booking>('/v1/bookings', {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify(input),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['slots', arenaId] }),
  });
}

export function useCancelBookingById(arenaId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (bookingId: string) =>
      apiFetch<Booking>(`/v1/bookings/${bookingId}/cancel`, { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['slots', arenaId] }),
  });
}

export function useHoldSlots(arenaId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (slotIds: string[]) =>
      apiFetch<{ held: number }>('/v1/slots/hold', {
        method: 'POST',
        body: JSON.stringify({ slotIds }),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['slots', arenaId] }),
  });
}

export function useReleaseHoldSlots(arenaId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (slotIds: string[]) =>
      apiFetch<{ released: number }>('/v1/slots/release-hold', {
        method: 'POST',
        body: JSON.stringify({ slotIds }),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['slots', arenaId] }),
  });
}

// ── Bookings hooks ────────────────────────────────────────────────────────────

export interface VenueBookingsParams {
  from: string;
  to: string;
  arenaId?: string;
  status?: string;
  q?: string;
}

export function useVenueBookings(venueId: string, params: VenueBookingsParams) {
  const qs = new URLSearchParams();
  qs.set('from', params.from);
  qs.set('to', params.to);
  if (params.arenaId) qs.set('arenaId', params.arenaId);
  if (params.status) qs.set('status', params.status);
  if (params.q) qs.set('q', params.q);
  return useQuery({
    queryKey: ['venue-bookings', venueId, params.from, params.to, params.arenaId, params.status, params.q],
    queryFn: () => apiFetch<BookingListItem[]>(`/v1/venues/${venueId}/bookings?${qs.toString()}`),
    enabled: Boolean(venueId),
  });
}

export function useBookingDetail(bookingId: string | null) {
  return useQuery({
    queryKey: ['booking-detail', bookingId],
    queryFn: () => apiFetch<BookingDetail>(`/v1/bookings/${bookingId}`),
    enabled: Boolean(bookingId),
  });
}
