import type { AddressSuggestion } from '@/lib/api/geocode';
import type { PinCoords } from '@/lib/map_view';

/** The address fields a picked suggestion fills, as the forms hold them. */
export interface PickedAddress {
  line1: string;
  city: string;
  state: string;
  postalCode: string;
  /** Null when the pick names no country we serve — keep the form's choice. */
  country: string | null;
  /** Null when the pick has no coordinates: the server geocodes the address. */
  coords: PinCoords | null;
}

/**
 * What a picked address suggestion makes the address fields. A pick is a new
 * address, so every field it knows replaces the old value and every field it
 * doesn't know is emptied — never left over from the previous address. Google
 * street results often carry no postal code, and keeping the old one would
 * save, say, Indiranagar with Koramangala's PIN. Line 2 (unit, floor) is the
 * partner's own and no provider fills it, so it is not touched.
 */
export function addressFromSuggestion(s: AddressSuggestion, now: Date = new Date()): PickedAddress {
  return {
    line1: s.line1 ?? '',
    city: s.city ?? '',
    state: s.state ?? '',
    postalCode: s.postalCode ?? '',
    country: s.country ?? null,
    coords:
      s.lat != null && s.lng != null
        ? {
            lat: s.lat,
            lng: s.lng,
            placeId: s.placeId,
            // Google's coordinates are kept 30 days from when it returned them.
            fetchedAt: s.placeId ? now.toISOString() : null,
          }
        : null,
  };
}

/** The setters of a form's address fields, for {@link applyAddressSuggestion}. */
export interface AddressFieldSetters {
  setLine1: (v: string) => void;
  setCity: (v: string) => void;
  setState: (v: string) => void;
  setPostalCode: (v: string) => void;
  setCountry: (v: string) => void;
  setCoords: (c: PinCoords | null) => void;
}

/** Fill a form's address fields and pin from a picked suggestion. */
export function applyAddressSuggestion(s: AddressSuggestion, set: AddressFieldSetters): void {
  const a = addressFromSuggestion(s);
  set.setLine1(a.line1);
  set.setCity(a.city);
  set.setState(a.state);
  set.setPostalCode(a.postalCode);
  if (a.country) set.setCountry(a.country);
  set.setCoords(a.coords);
}
