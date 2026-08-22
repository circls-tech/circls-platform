import { bigint, integer, pgTable, real, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, uuidPk } from './_columns.js';
import { tenants } from './tenants.js';
import { venues } from './venues.js';

/**
 * Photos attached to a Venue. Bytes live in the public R2 bucket; this table
 * only holds the object key + metadata. Public read URL is derived at the
 * service layer as `${R2_PUBLIC_BASE_URL}/${storageKey}` (CDN-cacheable, no
 * presign on read). Upload is a presigned PUT straight to R2 — the API never
 * touches the bytes.
 *
 * `position` orders the gallery (0 = primary/cover). `sizeBytes`/`mimeType`
 * are read back from R2 via HEAD at finalize time, never trusted from the
 * client.
 */
export const venueImages = pgTable('venue_images', {
  id: uuidPk(),
  venueId: uuid('venue_id')
    .notNull()
    .references(() => venues.id, { onDelete: 'cascade' }),
  // Denormalised for cheap tenant-scoped authz without a venue join.
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  storageKey: text('storage_key').notNull().unique(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }),
  position: integer('position').notNull().default(0),
  /** Intrinsic pixel size, reported by the browser at upload (HEAD can't give
   *  it). Cosmetic only — drives aspect-correct boxes; NULL on pre-focal rows,
   *  which fall back to the legacy fixed-height crop. */
  width: integer('width'),
  height: integer('height'),
  /** Crop anchor in 0..1 image space, rendered as CSS `object-position`.
   *  0.5/0.5 (the default) reproduces the old centre crop exactly. */
  focalX: real('focal_x').notNull().default(0.5),
  focalY: real('focal_y').notNull().default(0.5),
  createdAt: createdAt(),
});

export type VenueImage = typeof venueImages.$inferSelect;
export type NewVenueImage = typeof venueImages.$inferInsert;
