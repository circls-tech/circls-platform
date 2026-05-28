import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';
import type { VenueEvent } from './types';

export function useVenueEvents(venueId: string) {
  return useQuery({
    queryKey: ['venue-events', venueId],
    queryFn: () => apiFetch<VenueEvent[]>(`/v1/venues/${venueId}/events`),
    enabled: Boolean(venueId),
  });
}

export function useEvent(tenantId: string, eventId: string | null) {
  return useQuery({
    queryKey: ['event', tenantId, eventId],
    queryFn: () => apiFetch<VenueEvent>(`/v1/tenants/${tenantId}/events/${eventId}`),
    enabled: Boolean(tenantId && eventId),
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
  arenaIds: string[];
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

export function usePublishEvent(tenantId: string, venueId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (eventId: string) =>
      apiFetch<VenueEvent>(`/v1/tenants/${tenantId}/events/${eventId}/publish`, {
        method: 'POST',
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['venue-events', venueId] }),
  });
}
