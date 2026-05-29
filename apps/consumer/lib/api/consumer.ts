import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/lib/firebase/auth_context';
import { apiFetch } from './client';
import type {
  EventBookingResult,
  MembershipPurchaseResult,
  MyBooking,
  PublicEvent,
  PublicMembership,
  PublicSlot,
  PublicVenue,
  SlotBookingResult,
  VenueDetail,
} from './types';

// ── Browse (public, no auth) ──────────────────────────────────────────────────

export function useVenues(search: string) {
  const trimmed = search.trim();
  return useQuery({
    queryKey: ['venues', trimmed],
    queryFn: () => {
      const qs = new URLSearchParams();
      if (trimmed) qs.set('search', trimmed);
      qs.set('limit', '50');
      return apiFetch<{ rows: PublicVenue[] }>(`/v1/consumer/venues?${qs.toString()}`);
    },
    select: (data) => data.rows,
  });
}

export function useVenue(venueId: string) {
  return useQuery({
    queryKey: ['venue', venueId],
    queryFn: () => apiFetch<VenueDetail>(`/v1/consumer/venues/${venueId}`),
    enabled: Boolean(venueId),
  });
}

export function useVenueEvents(venueId: string) {
  return useQuery({
    queryKey: ['venue-events', venueId],
    queryFn: () => apiFetch<{ rows: PublicEvent[] }>(`/v1/consumer/venues/${venueId}/events`),
    enabled: Boolean(venueId),
    select: (data) => data.rows,
  });
}

export function useVenueMemberships(venueId: string) {
  return useQuery({
    queryKey: ['venue-memberships', venueId],
    queryFn: () =>
      apiFetch<{ rows: PublicMembership[] }>(`/v1/consumer/venues/${venueId}/memberships`),
    enabled: Boolean(venueId),
    select: (data) => data.rows,
  });
}

/** Open slots for an arena in the [fromISO, toISO) window. `enabled` lets the
 * caller defer the query until a date is selected. */
export function useArenaSlots(arenaId: string, fromISO: string, toISO: string, enabled = true) {
  return useQuery({
    queryKey: ['arena-slots', arenaId, fromISO, toISO],
    queryFn: () => {
      const qs = new URLSearchParams({ from: fromISO, to: toISO });
      return apiFetch<{ rows: PublicSlot[] }>(
        `/v1/consumer/arenas/${arenaId}/slots?${qs.toString()}`,
      );
    },
    enabled: Boolean(arenaId) && enabled,
    select: (data) => data.rows,
  });
}

// ── Book / purchase (authenticated) ───────────────────────────────────────────

export interface BookSlotsInput {
  slotIds: string[];
  customerName: string;
  customerContact: string;
  note?: string;
}

export function useBookSlots() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: BookSlotsInput) =>
      apiFetch<SlotBookingResult>('/v1/consumer/bookings', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['arena-slots'] });
      void qc.invalidateQueries({ queryKey: ['my-bookings'] });
    },
  });
}

export interface BookEventInput {
  eventId: string;
  name?: string;
  contact?: string;
}

export function useBookEvent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ eventId, ...body }: BookEventInput) =>
      apiFetch<EventBookingResult>(`/v1/consumer/events/${eventId}/book`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['my-bookings'] }),
  });
}

export function usePurchaseMembership() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (membershipId: string) =>
      apiFetch<MembershipPurchaseResult>(
        `/v1/consumer/memberships/${membershipId}/purchase`,
        { method: 'POST', body: JSON.stringify({}) },
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['my-bookings'] }),
  });
}

export function useMyBookings() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['my-bookings', user?.uid],
    queryFn: () => apiFetch<{ rows: MyBooking[] }>('/v1/consumer/me/bookings'),
    enabled: Boolean(user),
    select: (data) => data.rows,
  });
}
