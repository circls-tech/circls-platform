import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/lib/firebase/auth_context';
import { apiFetch } from './client';
import type {
  EventBookingResult,
  MembershipPurchaseResult,
  MyBooking,
  MyBookingDetail,
  PublicEvent,
  PublicEventWithVenue,
  PublicMembership,
  PublicMembershipWithScope,
  PublicSlot,
  PublicVenue,
  PurchaseMembershipInput,
  SlotBookingResult,
  VenueDetail,
} from './types';

// ── Browse (public, no auth) ──────────────────────────────────────────────────

export function useVenues(search: string, limit = 50) {
  const trimmed = search.trim();
  return useQuery({
    queryKey: ['venues', trimmed, limit],
    queryFn: () => {
      const qs = new URLSearchParams();
      if (trimmed) qs.set('search', trimmed);
      qs.set('limit', String(limit));
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

/**
 * All upcoming events across venues (server hides past + sorts ascending).
 * Depends on the GET /v1/consumer/events endpoint from spec §12.3 (handed off to
 * the API agent). Until that ships this query errors and callers show empty rows.
 */
export function useUpcomingEvents(limit = 50) {
  return useQuery({
    queryKey: ['events', limit],
    queryFn: () =>
      apiFetch<{ rows: PublicEventWithVenue[] }>(`/v1/consumer/events?limit=${limit}`),
    select: (data) => data.rows,
  });
}

/** A single public event (venue or standalone) by id. */
export function useEvent(eventId: string) {
  return useQuery({
    queryKey: ['event', eventId],
    queryFn: () => apiFetch<PublicEventWithVenue>(`/v1/consumer/events/${eventId}`),
    enabled: Boolean(eventId),
  });
}

/**
 * All active memberships across venues.
 * Depends on the GET /v1/consumer/memberships endpoint from spec §12.4 (handed off
 * to the API agent). Until that ships this query errors and callers show empty rows.
 */
export function useAllMemberships(limit = 50) {
  return useQuery({
    queryKey: ['memberships', limit],
    queryFn: () =>
      apiFetch<{ rows: PublicMembershipWithScope[] }>(`/v1/consumer/memberships?limit=${limit}`),
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
  couponCode?: string;
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
  lines: { tierId: string; quantity: number }[];
  name?: string;
  contact?: string;
  couponCode?: string;
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
    mutationFn: ({ membershipId, couponCode }: PurchaseMembershipInput) =>
      apiFetch<MembershipPurchaseResult>(
        `/v1/consumer/memberships/${membershipId}/purchase`,
        { method: 'POST', body: JSON.stringify(couponCode ? { couponCode } : {}) },
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

export function useMyBooking(id: string) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['my-booking', user?.uid, id],
    queryFn: () =>
      apiFetch<{ booking: MyBookingDetail }>(`/v1/consumer/me/bookings/${id}`),
    enabled: Boolean(user) && Boolean(id),
    select: (data) => data.booking,
  });
}
