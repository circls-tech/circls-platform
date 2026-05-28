// Local mirror of the API response shapes the portal consumes. (A shared
// @circls/api-types package is a future consolidation; kept local for now.)
export interface User {
  id: string;
  firebaseUid: string;
  phoneE164: string | null;
  email: string | null;
  displayName: string | null;
  status: 'active' | 'suspended';
}

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  kycStatus: string;
  subscriptionStatus: string;
  status: string;
}

export interface Venue {
  id: string;
  tenantId: string;
  name: string;
  tzName: string;
  lat: number | null;
  lng: number | null;
  status: string;
}

export interface Arena {
  id: string;
  venueId: string;
  name: string;
  sport: string | null;
  slotDurationMin: number;
  status: string;
}

export interface Slot {
  id: string;
  tenantId: string;
  arenaId: string;
  timeRange: string;
  pricePaise: number;
  status: 'open' | 'held' | 'blocked' | 'booked';
  holdExpiresAt: string | null;
  bookingId: string | null;
  releaseId: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** ISO-8601 string: lower bound of time_range (from Postgres lower(time_range)). */
  startAt: string;
  /** ISO-8601 string: upper bound of time_range (from Postgres upper(time_range)). */
  endAt: string;
}

export interface Booking {
  id: string;
  slotArenaId: string | null;
  timeRange: string | null;
  status: string;
  channel: string;
  paymentMethod: string;
  pricePaise: number | null;
}

export type BookingStatus = 'pending' | 'confirmed' | 'cancelled' | 'completed' | 'no_show';

export interface BookingListItem {
  id: string;
  customerName: string | null;
  customerContact: string | null;
  note: string | null;
  status: BookingStatus;
  channel: string;
  totalPaise: number;
  createdAt: string;
  arenaId: string;
  arenaName: string;
  firstStartAt: string;
  lastEndAt: string;
  slotCount: number;
}

export interface BookingSlot {
  id: string;
  startAt: string;
  endAt: string;
  pricePaise: number;
  status: string;
}

export interface BookingDetail {
  id: string;
  customerName: string | null;
  customerContact: string | null;
  note: string | null;
  status: BookingStatus;
  channel: string;
  paymentMethod: string;
  totalPaise: number;
  createdAt: string;
  venueId: string;
  arenaId: string;
  arenaName: string;
  slots: BookingSlot[];
}

export interface AnalyticsTrendDay {
  /** 'YYYY-MM-DD' */
  date: string;
  bookings: number;
  revenuePaise: number;
}

export interface Analytics {
  bookingsToday: number;
  revenueTodayPaise: number;
  revenue7dPaise: number;
  occupancy7dPct: number;
  /** 7 entries, oldest → newest (inclusive of today) */
  trend7d: AnalyticsTrendDay[];
}

export interface AuditLogItem {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  actorUserId: string | null;
  actorName: string | null;
  before: unknown;
  after: unknown;
  /** ISO-8601 */
  createdAt: string;
}

export interface AuditLogPage {
  rows: AuditLogItem[];
  nextCursor: string | null;
}
