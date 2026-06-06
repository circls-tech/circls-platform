import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/lib/firebase/auth_context';
import { apiFetch } from './client';
import type { EventBooking, VenueEvent } from './types';

export function useVenueEvents(venueId: string) {
  return useQuery({
    queryKey: ['venue-events', venueId],
    queryFn: () => apiFetch<VenueEvent[]>(`/v1/venues/${venueId}/events`),
    enabled: Boolean(venueId),
  });
}

/** All events for a tenant (venue-scoped + org-scoped). */
export function useTenantEvents(tenantId: string) {
  return useQuery({
    queryKey: ['tenant-events', tenantId],
    queryFn: () => apiFetch<VenueEvent[]>(`/v1/tenants/${tenantId}/events`),
    enabled: Boolean(tenantId),
  });
}

export interface CreateTenantEventInput {
  /** Provide exactly one scope: a venueId OR a standalone address. */
  venueId?: string;
  addressJson?: Record<string, unknown>;
  lat?: number;
  lng?: number;
  tzName?: string;
  name: string;
  description?: string;
  /** ISO-8601, with tz. */
  startsAt: string;
  endsAt: string;
  pricePaise: number;
  capacity?: number;
}

export function useCreateTenantEvent(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTenantEventInput) =>
      apiFetch<VenueEvent>(`/v1/tenants/${tenantId}/events`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['tenant-events', tenantId] }),
  });
}

export function useEvent(tenantId: string, eventId: string | null) {
  return useQuery({
    queryKey: ['event', tenantId, eventId],
    queryFn: () => apiFetch<VenueEvent>(`/v1/tenants/${tenantId}/events/${eventId}`),
    enabled: Boolean(tenantId && eventId),
  });
}

/** Consumer registrations for an event (partner-facing). */
export function useEventBookings(tenantId: string, eventId: string) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['event-bookings', tenantId, eventId],
    queryFn: () =>
      apiFetch<{ rows: EventBooking[] }>(`/v1/tenants/${tenantId}/events/${eventId}/bookings`),
    enabled: Boolean(user) && Boolean(tenantId) && Boolean(eventId),
  });
}

export interface CreateEventInput {
  name: string;
  description?: string;
  /** ISO-8601, with tz. */
  startsAt: string;
  endsAt: string;
  pricePaise: number;
  capacity?: number;
}

export function useCreateEvent(venueId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateEventInput) =>
      apiFetch<VenueEvent>(`/v1/venues/${venueId}/events`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['venue-events', venueId] }),
  });
}

export interface UpdateEventInput {
  name?: string;
  description?: string;
  /** ISO-8601, with tz. */
  startsAt?: string;
  endsAt?: string;
  pricePaise?: number;
  capacity?: number;
}

/** PATCH an event (draft only — API returns 409 event_not_draft otherwise). */
export function useUpdateEvent(tenantId: string, venueId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ eventId, input }: { eventId: string; input: UpdateEventInput }) =>
      apiFetch<VenueEvent>(`/v1/tenants/${tenantId}/events/${eventId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: (ev) => {
      void qc.invalidateQueries({ queryKey: ['venue-events', venueId] });
      void qc.invalidateQueries({ queryKey: ['event', tenantId, ev.id] });
    },
  });
}

export function usePublishEvent(tenantId: string, venueId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (eventId: string) =>
      apiFetch<VenueEvent>(`/v1/tenants/${tenantId}/events/${eventId}/publish`, {
        method: 'POST',
      }),
    onSuccess: (ev) => {
      void qc.invalidateQueries({ queryKey: ['venue-events', venueId] });
      void qc.invalidateQueries({ queryKey: ['tenant-events', tenantId] });
      void qc.invalidateQueries({ queryKey: ['event', tenantId, ev.id] });
    },
  });
}

/**
 * Submit an event for review from the org-scoped Events tab (works for both
 * venue-scoped and standalone events — same backend endpoint as the venue
 * path). Invalidates the tenant-events list the tab renders from.
 */
export function usePublishTenantEvent(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (eventId: string) =>
      apiFetch<VenueEvent>(`/v1/tenants/${tenantId}/events/${eventId}/publish`, {
        method: 'POST',
      }),
    onSuccess: (ev) => {
      void qc.invalidateQueries({ queryKey: ['tenant-events', tenantId] });
      if (ev.venueId) void qc.invalidateQueries({ queryKey: ['venue-events', ev.venueId] });
      void qc.invalidateQueries({ queryKey: ['event', tenantId, ev.id] });
    },
  });
}

/** Cancel an event (API returns 409 event_not_cancellable if already cancelled/rejected). */
export function useCancelEvent(tenantId: string, venueId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (eventId: string) =>
      apiFetch<VenueEvent>(`/v1/tenants/${tenantId}/events/${eventId}/cancel`, {
        method: 'POST',
      }),
    onSuccess: (ev) => {
      void qc.invalidateQueries({ queryKey: ['venue-events', venueId] });
      void qc.invalidateQueries({ queryKey: ['event', tenantId, ev.id] });
    },
  });
}
