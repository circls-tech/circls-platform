/**
 * Venue trust-metadata helpers (PR #109): the canonical amenity vocabulary and
 * the opening-hours validator, shared by the venue routes (write validation)
 * and exposed to the partner UI as the multi-select options.
 */
import { z } from 'zod';
import type { VenueOpeningHours } from '../db/schema/venues.js';

/**
 * Canonical facility tags a venue can advertise. The partner UI renders these as
 * multi-select chips; writes are validated against this list so the consumer
 * side can rely on a closed vocabulary (icons, filters). Extend deliberately —
 * removing a value silently drops it from existing venues on next save.
 */
export const VENUE_AMENITIES = [
  'parking',
  'restrooms',
  'changing_rooms',
  'showers',
  'drinking_water',
  'cafe',
  'equipment_rental',
  'first_aid',
  'wifi',
  'lockers',
  'seating',
  'floodlights',
  'air_conditioning',
  'wheelchair_accessible',
  'pro_shop',
  'coaching',
] as const;

export type VenueAmenity = (typeof VENUE_AMENITIES)[number];

const AMENITY_SET = new Set<string>(VENUE_AMENITIES);

export const amenitiesSchema = z
  .array(z.string())
  .max(VENUE_AMENITIES.length)
  .refine((arr) => arr.every((a) => AMENITY_SET.has(a)), {
    message: `amenities must be from the canonical list: ${VENUE_AMENITIES.join(', ')}`,
  })
  // De-dupe while preserving order.
  .transform((arr) => Array.from(new Set(arr)));

/** "HH:MM" 24-hour clock. */
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const timeRange = z
  .object({ open: z.string().regex(TIME_RE), close: z.string().regex(TIME_RE) })
  .refine((r) => r.open < r.close, { message: 'open must be before close (same-day ranges only)' });

/**
 * Opening hours keyed by weekday index "0"–"6" (0 = Sunday). A missing key or an
 * empty array means closed that day. Ranges are venue-local "HH:MM" times.
 */
export const openingHoursSchema = z
  .record(z.enum(['0', '1', '2', '3', '4', '5', '6']), z.array(timeRange).max(4))
  .transform((v) => v as VenueOpeningHours);
