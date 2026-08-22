import { bigint, integer, pgTable, real, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, uuidPk } from './_columns.js';
import { events } from './events.js';
import { tenants } from './tenants.js';

/**
 * Photos attached to an Event. Mirrors {@link venueImages} exactly (bytes in
 * the public R2 bucket; this row holds the key + metadata; public URL is
 * `${R2_PUBLIC_BASE_URL}/${storageKey}`). `position` orders the gallery (0 =
 * primary/cover). See venue_images.ts for the rationale.
 */
export const eventImages = pgTable('event_images', {
  id: uuidPk(),
  eventId: uuid('event_id')
    .notNull()
    .references(() => events.id, { onDelete: 'cascade' }),
  // Denormalised for cheap tenant-scoped authz without an events join.
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

export type EventImage = typeof eventImages.$inferSelect;
export type NewEventImage = typeof eventImages.$inferInsert;
