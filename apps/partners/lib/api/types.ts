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

export interface Booking {
  id: string;
  slotArenaId: string | null;
  timeRange: string | null;
  status: string;
  channel: string;
  paymentMethod: string;
  pricePaise: number | null;
}
