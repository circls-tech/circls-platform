import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/lib/firebase/auth_context';
import { apiFetch } from './client';
import type { EventBooking, QrTicketConfig, VenueEvent, VenueEventSummary } from './types';

export function useVenueEvents(venueId: string) {
  return useQuery({
    queryKey: ['venue-events', venueId],
    queryFn: () => apiFetch<VenueEventSummary[]>(`/v1/venues/${venueId}/events`),
    enabled: Boolean(venueId),
  });
}

/** All events for a tenant (venue-scoped + org-scoped). */
export function useTenantEvents(tenantId: string) {
  return useQuery({
    queryKey: ['tenant-events', tenantId],
    queryFn: () => apiFetch<VenueEventSummary[]>(`/v1/tenants/${tenantId}/events`),
    enabled: Boolean(tenantId),
  });
}

/** A ticket-tier payload for event create/update. `capacity: null` = unlimited. */
export interface TierInput {
  name: string;
  description?: string;
  pricePaise: number;
  capacity: number | null;
  /** Per-tier QR override: null = inherit the event's config;
   *  `enabled: false` = off for this tier; enabled = custom rules. */
  qrTicketConfig?: QrTicketConfig | null;
}

/** A registration-question payload for event create/update. */
export interface EventQuestionInput {
  label: string;
  /** 'text' = free text; 'select' = one of `options`. */
  type: 'text' | 'select';
  required: boolean;
  /** Choices for 'select' questions (min 2); omit for free-text. */
  options?: string[];
}

/**
 * One date of a recurring event. Omitted fields inherit the base payload;
 * `venueId` moves that date to another venue.
 */
export interface OccurrenceInput {
  /** ISO-8601, with tz. */
  startsAt: string;
  endsAt: string;
  venueId?: string;
  tiers?: TierInput[];
}

/** Create response for a recurring event: one draft per date, one series. */
export interface EventSeriesResult {
  seriesId: string;
  count: number;
  events: VenueEventSummary[];
}

export type CreateEventResult = VenueEventSummary | EventSeriesResult;

export function isSeriesResult(r: CreateEventResult): r is EventSeriesResult {
  return 'events' in r;
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
  /** ISO-8601, with tz. Required unless `occurrences` is set. */
  startsAt?: string;
  endsAt?: string;
  /** Ticket tiers (min 1). */
  tiers: TierInput[];
  /** Registration questions consumers answer at booking; omit for none. */
  questions?: EventQuestionInput[];
  /** Per-customer ticket cap for the whole event (all tiers); null/omitted = no limit. */
  maxPerUser?: number | null;
  /** QR ticket rules; null/omitted = disabled. */
  qrTicketConfig?: QrTicketConfig | null;
  /** 2+ dates makes this a recurring series (one draft event per date). */
  occurrences?: OccurrenceInput[];
}

export function useCreateTenantEvent(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTenantEventInput) =>
      apiFetch<CreateEventResult>(`/v1/tenants/${tenantId}/events`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['tenant-events', tenantId] }),
  });
}

/** All occurrences of a recurring event owned by the tenant, soonest first. */
export function useEventSeries(tenantId: string, seriesId: string | null) {
  return useQuery({
    queryKey: ['event-series', tenantId, seriesId],
    queryFn: () =>
      apiFetch<{ seriesId: string; events: VenueEventSummary[] }>(
        `/v1/tenants/${tenantId}/event-series/${seriesId}`,
      ),
    enabled: Boolean(tenantId && seriesId),
  });
}

/** Submit every draft date of a series for review at once. */
export function usePublishEventSeries(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (seriesId: string) =>
      apiFetch<EventSeriesResult>(`/v1/tenants/${tenantId}/event-series/${seriesId}/publish`, {
        method: 'POST',
      }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['tenant-events', tenantId] });
      void qc.invalidateQueries({ queryKey: ['event-series', tenantId, r.seriesId] });
      for (const ev of r.events) {
        void qc.invalidateQueries({ queryKey: ['event', tenantId, ev.id] });
        if (ev.venueId) void qc.invalidateQueries({ queryKey: ['venue-events', ev.venueId] });
      }
    },
  });
}

/** Cancel every remaining (non-terminal) date of a series at once. */
export function useCancelEventSeries(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (seriesId: string) =>
      apiFetch<EventSeriesResult>(`/v1/tenants/${tenantId}/event-series/${seriesId}/cancel`, {
        method: 'POST',
      }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['tenant-events', tenantId] });
      void qc.invalidateQueries({ queryKey: ['event-series', tenantId, r.seriesId] });
      for (const ev of r.events) {
        void qc.invalidateQueries({ queryKey: ['event', tenantId, ev.id] });
        if (ev.venueId) void qc.invalidateQueries({ queryKey: ['venue-events', ev.venueId] });
      }
    },
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
  /** ISO-8601, with tz. Required unless `occurrences` is set. */
  startsAt?: string;
  endsAt?: string;
  /** Ticket tiers (min 1). */
  tiers: TierInput[];
  /** Registration questions consumers answer at booking; omit for none. */
  questions?: EventQuestionInput[];
  /** Per-customer ticket cap for the whole event (all tiers); null/omitted = no limit. */
  maxPerUser?: number | null;
  /** QR ticket rules; null/omitted = disabled. */
  qrTicketConfig?: QrTicketConfig | null;
  /** 2+ dates makes this a recurring series (one draft event per date). */
  occurrences?: OccurrenceInput[];
}

export function useCreateEvent(venueId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateEventInput) =>
      apiFetch<CreateEventResult>(`/v1/venues/${venueId}/events`, {
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
  /** Replace-all ticket tiers (draft only). */
  tiers?: TierInput[];
  /** Replace-all registration questions (draft only; [] clears). */
  questions?: EventQuestionInput[];
  /** Re-scope the event: a venue id → venue-scoped; null → standalone. */
  venueId?: string | null;
  /** Standalone address — applied when the event is (or becomes) standalone.
   * Omit lat/lng to have the API derive them from the address (its geocoder). */
  addressJson?: Record<string, unknown>;
  tzName?: string;
  lat?: number | null;
  lng?: number | null;
  /** Per-customer ticket cap; null clears, omit to leave unchanged. */
  maxPerUser?: number | null;
  /** QR ticket rules; null = disable. Omit to leave unchanged. */
  qrTicketConfig?: QrTicketConfig | null;
  /** Published-only: raise tiers' capacity by id (null = unlimited). The API
   *  rejects decreases (`event_capacity_decrease`). */
  tierCapacities?: { tierId: string; capacity: number | null }[];
}

/** PATCH an event. Drafts: any field. Published: only `maxPerUser` +
 *  `tierCapacities` (live settings) — anything else is 409 event_not_draft. */
export function useUpdateEvent(tenantId: string, venueId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ eventId, input }: { eventId: string; input: UpdateEventInput }) =>
      apiFetch<VenueEventSummary>(`/v1/tenants/${tenantId}/events/${eventId}`, {
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
      apiFetch<VenueEventSummary>(`/v1/tenants/${tenantId}/events/${eventId}/publish`, {
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
      apiFetch<VenueEventSummary>(`/v1/tenants/${tenantId}/events/${eventId}/publish`, {
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
      apiFetch<VenueEventSummary>(`/v1/tenants/${tenantId}/events/${eventId}/cancel`, {
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
 * Tenant-scoped variants for the org-scoped Events tab / detail page. The event
 * may be venue-scoped or standalone, so these invalidate the tenant-events list
 * (and the venue list when the event has a venue). The update hook supports
 * re-scoping via `input.venueId` (a venue id, or null for standalone).
 */
export function useUpdateTenantEvent(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ eventId, input }: { eventId: string; input: UpdateEventInput }) =>
      apiFetch<VenueEventSummary>(`/v1/tenants/${tenantId}/events/${eventId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: (ev) => {
      void qc.invalidateQueries({ queryKey: ['tenant-events', tenantId] });
      if (ev.venueId) void qc.invalidateQueries({ queryKey: ['venue-events', ev.venueId] });
      void qc.invalidateQueries({ queryKey: ['event', tenantId, ev.id] });
    },
  });
}

export function useCancelTenantEvent(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (eventId: string) =>
      apiFetch<VenueEventSummary>(`/v1/tenants/${tenantId}/events/${eventId}/cancel`, {
        method: 'POST',
      }),
    onSuccess: (ev) => {
      void qc.invalidateQueries({ queryKey: ['tenant-events', tenantId] });
      if (ev.venueId) void qc.invalidateQueries({ queryKey: ['venue-events', ev.venueId] });
      void qc.invalidateQueries({ queryKey: ['event', tenantId, ev.id] });
    },
  });
}
