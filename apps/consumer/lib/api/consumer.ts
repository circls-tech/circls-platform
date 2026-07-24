import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/lib/firebase/auth_context';
import { apiFetch } from './client';
import type {
  EventBookingResult,
  MembershipPurchaseResult,
  MyBooking,
  MyBookingDetail,
  MyProfile,
  PublicEvent,
  PublicEventWithVenue,
  PublicMembershipWithScope,
  PublicOrg,
  PublicSlot,
  PublicVenue,
  PurchaseMembershipInput,
  SlotBookingResult,
  VenueDetail,
} from './types';

// ── Browse (public, no auth) ──────────────────────────────────────────────────

/** A public org/brand profile by slug (PR #108). 404s for inactive/missing orgs. */
export function usePublicOrg(slug: string) {
  return useQuery({
    queryKey: ['org', slug],
    queryFn: () => apiFetch<PublicOrg>(`/v1/consumer/orgs/${slug}`),
    enabled: Boolean(slug),
  });
}

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
      apiFetch<{ rows: PublicMembershipWithScope[] }>(`/v1/consumer/venues/${venueId}/memberships`),
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

/**
 * A single public event (venue or standalone) by id. `accessCode` unlocks an
 * invite-only event — without it (or with a wrong code) the event comes back
 * `locked: true` with no tiers.
 */
export function useEvent(eventId: string, accessCode?: string) {
  return useQuery({
    queryKey: ['event', eventId, accessCode ?? null],
    queryFn: () =>
      apiFetch<PublicEventWithVenue>(
        `/v1/consumer/events/${eventId}${accessCode ? `?code=${encodeURIComponent(accessCode)}` : ''}`,
      ),
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

/** A single public membership (venue-scoped or tenant-wide) by id. */
export function useMembership(membershipId: string) {
  return useQuery({
    queryKey: ['membership', membershipId],
    queryFn: () =>
      apiFetch<PublicMembershipWithScope>(`/v1/consumer/memberships/${membershipId}`),
    enabled: Boolean(membershipId),
  });
}

/**
 * Coarse place (city/country) for device coords — labels the navbar pin when
 * the user is outside every served city. Best-effort: null on any failure,
 * callers fall back to the country label. Plain function (not a hook) because
 * it's called imperatively from the geolocation callback.
 */
export async function reverseGeocode(
  lat: number,
  lng: number,
): Promise<{ city: string | null; country: string | null } | null> {
  try {
    const qs = new URLSearchParams({ lat: String(lat), lng: String(lng) });
    const res = await apiFetch<{ place: { city: string | null; country: string | null } | null }>(
      `/v1/consumer/geocode/reverse?${qs.toString()}`,
    );
    return res.place;
  } catch {
    return null;
  }
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
  /** Required for invite-only (access_code) events. */
  accessCode?: string;
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
    mutationFn: ({ membershipId, membershipTierId, couponCode }: PurchaseMembershipInput) =>
      apiFetch<MembershipPurchaseResult>(
        `/v1/consumer/memberships/${membershipId}/purchase`,
        {
          method: 'POST',
          body: JSON.stringify({
            ...(membershipTierId ? { membershipTierId } : {}),
            ...(couponCode ? { couponCode } : {}),
          }),
        },
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['my-bookings'] }),
  });
}

// ── My profile ────────────────────────────────────────────────────────────────

/** The signed-in user's profile row (phone, name, email). */
export function useMyProfile() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['my-profile', user?.uid],
    queryFn: () => apiFetch<{ profile: MyProfile }>('/v1/consumer/me'),
    enabled: Boolean(user),
    select: (data) => data.profile,
  });
}

/** Fields a consumer may change about themselves. Phone is identity — not editable. */
export interface UpdateMyProfileInput {
  displayName?: string;
  email?: string;
}

export function useUpdateMyProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateMyProfileInput) =>
      apiFetch<{ profile: MyProfile }>('/v1/consumer/me', {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    // Write the fresh profile straight into the cache so gates that depend on it
    // (e.g. the pre-payment contact-details step) unblock without a refetch.
    onSuccess: (data) => {
      qc.setQueriesData({ queryKey: ['my-profile'] }, data);
    },
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
