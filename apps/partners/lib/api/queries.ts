import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/lib/firebase/auth_context';
import { apiFetch } from './client';
import type {
  Analytics,
  ApiKey,
  ApiKeyCreateResult,
  Arena,
  AuditLogPage,
  Booking,
  BookingDetail,
  BookingListItem,
  CancelResult,
  CreateInvitationResponse,
  EventImage,
  NotificationsPage,
  Payment,
  PresignedUpload,
  Slot,
  TeamMember,
  Tenant,
  TenantInvitation,
  TenantRole,
  User,
  Venue,
  VenueImage,
  WebhookDeliveryPage,
  WebhookSubscription,
  WebhookSubscriptionCreateResult,
} from './types';

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
    enabled: Boolean(tenantId),
  });
}

export function useCreateVenue(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; tzName?: string; tags?: string[] }) =>
      apiFetch<Venue>(`/v1/tenants/${tenantId}/venues`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['venues', tenantId] }),
  });
}

// ── Venue images (R2) ─────────────────────────────────────────────────────────

/** Allowed image types + per-file size cap — mirror the API's server-side rules. */
export const VENUE_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const VENUE_IMAGE_MAX_BYTES = 10 * 1024 * 1024; // 10 MiB

export function useVenueImages(venueId: string) {
  return useQuery({
    queryKey: ['venue-images', venueId],
    queryFn: () => apiFetch<VenueImage[]>(`/v1/venues/${venueId}/images`),
    enabled: Boolean(venueId),
  });
}

/**
 * Three-step upload: (1) ask the API for a presigned PUT, (2) PUT the file
 * straight to R2 (raw fetch — NOT apiFetch, so no auth header and the exact
 * presigned Content-Type), (3) finalize so the API records the row.
 */
export function useUploadVenueImage(venueId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (file: File): Promise<VenueImage> => {
      if (!VENUE_IMAGE_TYPES.includes(file.type)) {
        throw new Error('Use a JPEG, PNG, or WebP image.');
      }
      if (file.size > VENUE_IMAGE_MAX_BYTES) {
        throw new Error('Image is too large (max 10 MB).');
      }
      const presign = await apiFetch<PresignedUpload>(
        `/v1/venues/${venueId}/images/upload-presign`,
        { method: 'POST', body: JSON.stringify({ contentType: file.type }) },
      );
      const put = await fetch(presign.uploadUrl, {
        method: 'PUT',
        headers: presign.headers,
        body: file,
      });
      if (!put.ok) throw new Error(`Upload to storage failed (${put.status}).`);
      return apiFetch<VenueImage>(`/v1/venues/${venueId}/images`, {
        method: 'POST',
        body: JSON.stringify({ storageKey: presign.storageKey }),
      });
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['venue-images', venueId] }),
  });
}

export function useDeleteVenueImage(venueId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (imageId: string) =>
      apiFetch<{ ok: true }>(`/v1/venues/${venueId}/images/${imageId}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['venue-images', venueId] }),
  });
}

// ── Event images (R2) ─────────────────────────────────────────────────────────
// Same flow/limits as venue images, against /v1/events/:id/images.

export function useEventImages(eventId: string) {
  return useQuery({
    queryKey: ['event-images', eventId],
    queryFn: () => apiFetch<EventImage[]>(`/v1/events/${eventId}/images`),
    enabled: Boolean(eventId),
  });
}

export function useUploadEventImage(eventId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (file: File): Promise<EventImage> => {
      if (!VENUE_IMAGE_TYPES.includes(file.type)) {
        throw new Error('Use a JPEG, PNG, or WebP image.');
      }
      if (file.size > VENUE_IMAGE_MAX_BYTES) {
        throw new Error('Image is too large (max 10 MB).');
      }
      const presign = await apiFetch<PresignedUpload>(
        `/v1/events/${eventId}/images/upload-presign`,
        { method: 'POST', body: JSON.stringify({ contentType: file.type }) },
      );
      const put = await fetch(presign.uploadUrl, {
        method: 'PUT',
        headers: presign.headers,
        body: file,
      });
      if (!put.ok) throw new Error(`Upload to storage failed (${put.status}).`);
      return apiFetch<EventImage>(`/v1/events/${eventId}/images`, {
        method: 'POST',
        body: JSON.stringify({ storageKey: presign.storageKey }),
      });
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['event-images', eventId] }),
  });
}

export function useDeleteEventImage(eventId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (imageId: string) =>
      apiFetch<{ ok: true }>(`/v1/events/${eventId}/images/${imageId}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['event-images', eventId] }),
  });
}

export function useArenas(venueId: string) {
  return useQuery({
    queryKey: ['arenas', venueId],
    queryFn: () => apiFetch<Arena[]>(`/v1/venues/${venueId}/arenas`),
    enabled: Boolean(venueId),
  });
}

export function useArena(arenaId: string | null) {
  return useQuery({
    queryKey: ['arena', arenaId],
    queryFn: () => apiFetch<Arena>('/v1/arenas/' + arenaId!),
    enabled: Boolean(arenaId),
  });
}

export function useCreateArena(venueId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; sport?: string; slotDurationMin?: number; tags?: string[] }) =>
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
      apiFetch<Booking>(`/v1/bookings/${bookingId}/cancel`, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['slots', arenaId] }),
  });
}

export interface CancelBookingInput {
  bookingId: string;
  reason: string;
}

/**
 * Phase 14 cancellation flow. POSTs a reason and returns the refund decision
 * from the cancellation engine.
 */
export function useCancelBookingWithReason() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ bookingId, reason }: CancelBookingInput) =>
      apiFetch<CancelResult>(`/v1/bookings/${bookingId}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['slots'] });
      void qc.invalidateQueries({ queryKey: ['venue-bookings'] });
      void qc.invalidateQueries({ queryKey: ['booking-detail'] });
      void qc.invalidateQueries({ queryKey: ['booking-payments'] });
    },
  });
}

/**
 * Payment ledger rows for a booking — charges, refunds, and adjustments.
 */
export function useBookingPayments(bookingId: string | null) {
  return useQuery({
    queryKey: ['booking-payments', bookingId],
    queryFn: () => apiFetch<Payment[]>(`/v1/bookings/${bookingId}/payments`),
    enabled: Boolean(bookingId),
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

// ── Analytics hooks ───────────────────────────────────────────────────────────

export function useAnalytics(tenantId: string) {
  return useQuery({
    queryKey: ['analytics', tenantId],
    queryFn: () => apiFetch<Analytics>(`/v1/tenants/${tenantId}/analytics`),
    enabled: Boolean(tenantId),
  });
}

// ── Audit log hooks ───────────────────────────────────────────────────────────

export interface AuditLogParams {
  action?: string;
  entityType?: string;
  from?: string;
  to?: string;
}

export function useAuditLog(tenantId: string, params: AuditLogParams = {}) {
  return useInfiniteQuery({
    queryKey: ['audit-log', tenantId, params.action, params.entityType, params.from, params.to],
    enabled: Boolean(tenantId),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: AuditLogPage) => last.nextCursor ?? undefined,
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams();
      if (params.action)     qs.set('action',     params.action);
      if (params.entityType) qs.set('entityType', params.entityType);
      if (params.from)       qs.set('from',       params.from);
      if (params.to)         qs.set('to',         params.to);
      if (pageParam)         qs.set('cursor',     pageParam);
      const query = qs.toString();
      return apiFetch<AuditLogPage>(
        `/v1/tenants/${tenantId}/audit-log${query ? `?${query}` : ''}`,
      );
    },
  });
}

// ── Notifications (Phase 13) ──────────────────────────────────────────────────

export interface NotificationsParams {
  channel?: 'sms' | 'email' | 'whatsapp';
  status?: 'pending' | 'sent' | 'failed' | 'skipped';
}

export function useNotifications(tenantId: string, params: NotificationsParams = {}) {
  return useInfiniteQuery({
    queryKey: ['notifications', tenantId, params.channel, params.status],
    enabled: Boolean(tenantId),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: NotificationsPage) => last.nextCursor ?? undefined,
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams();
      if (params.channel) qs.set('channel', params.channel);
      if (params.status)  qs.set('status',  params.status);
      if (pageParam)      qs.set('cursor',  pageParam);
      const query = qs.toString();
      return apiFetch<NotificationsPage>(
        `/v1/tenants/${tenantId}/notifications${query ? `?${query}` : ''}`,
      );
    },
  });
}

// ── Phase 17: API keys ────────────────────────────────────────────────────────

export function useApiKeys(tenantId: string) {
  return useQuery({
    queryKey: ['api-keys', tenantId],
    queryFn: () => apiFetch<ApiKey[]>(`/v1/tenants/${tenantId}/api-keys`),
    enabled: Boolean(tenantId),
  });
}

export function useCreateApiKey(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; role: 'read' | 'write' | 'admin'; scopes?: string[] }) =>
      apiFetch<ApiKeyCreateResult>(`/v1/tenants/${tenantId}/api-keys`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['api-keys', tenantId] }),
  });
}

export function useRevokeApiKey(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/v1/tenants/${tenantId}/api-keys/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['api-keys', tenantId] }),
  });
}

// ── Phase 17: Webhook subscriptions ──────────────────────────────────────────

export function useWebhookSubscriptions(tenantId: string) {
  return useQuery({
    queryKey: ['webhook-subscriptions', tenantId],
    queryFn: () =>
      apiFetch<WebhookSubscription[]>(`/v1/tenants/${tenantId}/webhook-subscriptions`),
    enabled: Boolean(tenantId),
  });
}

export function useCreateWebhookSubscription(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { url: string; events: string[] }) =>
      apiFetch<WebhookSubscriptionCreateResult>(
        `/v1/tenants/${tenantId}/webhook-subscriptions`,
        { method: 'POST', body: JSON.stringify(input) },
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['webhook-subscriptions', tenantId] }),
  });
}

export function useDeleteWebhookSubscription(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/v1/tenants/${tenantId}/webhook-subscriptions/${id}`, {
        method: 'DELETE',
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['webhook-subscriptions', tenantId] }),
  });
}

export function useWebhookDeliveries(tenantId: string, subId: string) {
  return useInfiniteQuery({
    queryKey: ['webhook-deliveries', tenantId, subId],
    enabled: Boolean(tenantId && subId),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: WebhookDeliveryPage) => last.nextCursor ?? undefined,
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams();
      if (pageParam) qs.set('cursor', pageParam);
      const query = qs.toString();
      return apiFetch<WebhookDeliveryPage>(
        `/v1/tenants/${tenantId}/webhook-subscriptions/${subId}/deliveries${query ? `?${query}` : ''}`,
      );
    },
  });
}

// ── Team management (subproject D) ───────────────────────────────────────────

export function useTeamMembers(tenantId: string) {
  return useQuery({
    queryKey: ['team-members', tenantId],
    queryFn: () => apiFetch<TeamMember[]>(`/v1/tenants/${tenantId}/members`),
    enabled: Boolean(tenantId),
  });
}

export function useUpdateMemberRole(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: TenantRole }) =>
      apiFetch<TeamMember>(`/v1/tenants/${tenantId}/members/${userId}`, {
        method: 'PATCH',
        body: JSON.stringify({ role }),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['team-members', tenantId] }),
  });
}

export function useRemoveMember(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      apiFetch<void>(`/v1/tenants/${tenantId}/members/${userId}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['team-members', tenantId] }),
  });
}

export function useTeamInvitations(
  tenantId: string,
  status?: 'pending' | 'accepted' | 'expired' | 'revoked',
) {
  return useQuery({
    queryKey: ['team-invitations', tenantId, status],
    queryFn: () => {
      const qs = status ? `?status=${status}` : '';
      return apiFetch<TenantInvitation[]>(`/v1/tenants/${tenantId}/invitations${qs}`);
    },
    enabled: Boolean(tenantId),
  });
}

export function useCreateInvitation(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; role: TenantRole }) =>
      apiFetch<CreateInvitationResponse>(`/v1/tenants/${tenantId}/invitations`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['team-invitations', tenantId] }),
  });
}

export function useResendInvitation(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (invitationId: string) =>
      apiFetch<CreateInvitationResponse>(
        `/v1/tenants/${tenantId}/invitations/${invitationId}/resend`,
        { method: 'POST' },
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['team-invitations', tenantId] }),
  });
}

export function useRevokeInvitation(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (invitationId: string) =>
      apiFetch<void>(`/v1/tenants/${tenantId}/invitations/${invitationId}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['team-invitations', tenantId] }),
  });
}
