import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type EventImage, eventImages, events } from '../db/schema/index.js';
import { BadRequest, Conflict, NotFound } from '../lib/errors.js';
import { getStorage, type PresignedUpload } from '../lib/storage.js';
import type {
  FocalPoint,
  ImageDimensions,
  PublicImageRef,
} from './venue_image_service.js';

/** Image content-types we accept, mapped to the key extension we store under. */
const ALLOWED_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MiB
const MAX_IMAGES_PER_EVENT = 12;

export interface EventImageDTO {
  id: string;
  eventId: string;
  storageKey: string;
  url: string;
  mimeType: string;
  sizeBytes: number | null;
  position: number;
  width: number | null;
  height: number | null;
  focalX: number;
  focalY: number;
  createdAt: Date;
}

function toDTO(row: EventImage): EventImageDTO {
  return {
    id: row.id,
    eventId: row.eventId,
    storageKey: row.storageKey,
    url: getStorage().publicUrl(row.storageKey),
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    position: row.position,
    width: row.width,
    height: row.height,
    focalX: row.focalX,
    focalY: row.focalY,
    createdAt: row.createdAt,
  };
}

/** Object-key prefix that scopes every image to its event. */
function eventPrefix(eventId: string): string {
  return `events/${eventId}/`;
}

/** Step 1: hand the client a presigned PUT (we pick the key). Enforces the cap. */
export async function presignEventImageUpload(
  eventId: string,
  contentType: string,
): Promise<PresignedUpload> {
  const ext = ALLOWED_TYPES[contentType];
  if (!ext) {
    throw new BadRequest(
      `Unsupported image type "${contentType}" (allowed: ${Object.keys(ALLOWED_TYPES).join(', ')})`,
      'unsupported_media_type',
    );
  }

  const countRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(eventImages)
    .where(eq(eventImages.eventId, eventId));
  const count = countRows[0]?.count ?? 0;
  if (count >= MAX_IMAGES_PER_EVENT) {
    throw new Conflict(
      `Event already has the maximum of ${MAX_IMAGES_PER_EVENT} images`,
      'too_many_images',
    );
  }

  const key = `${eventPrefix(eventId)}${randomUUID()}.${ext}`;
  return getStorage().presignUpload({ key, contentType });
}

/** Step 2: verify the object exists in R2, read real size/type, persist the row. */
export async function finalizeEventImage(
  tenantId: string,
  eventId: string,
  storageKey: string,
  dimensions?: ImageDimensions,
): Promise<EventImageDTO> {
  if (!storageKey.startsWith(eventPrefix(eventId))) {
    throw new BadRequest('storageKey does not belong to this event', 'bad_storage_key');
  }

  const head = await getStorage().head(storageKey);
  if (!head) {
    throw new BadRequest('No uploaded object found for that storageKey', 'upload_not_found');
  }
  if (!ALLOWED_TYPES[head.contentType]) {
    await getStorage().delete(storageKey);
    throw new BadRequest(
      `Uploaded object is "${head.contentType}", not an allowed image type`,
      'unsupported_media_type',
    );
  }
  if (head.sizeBytes > MAX_IMAGE_BYTES) {
    await getStorage().delete(storageKey);
    throw new BadRequest(
      `Image is ${head.sizeBytes} bytes; max is ${MAX_IMAGE_BYTES}`,
      'image_too_large',
    );
  }

  const posRows = await db
    .select({ nextPos: sql<number>`coalesce(max(${eventImages.position}) + 1, 0)::int` })
    .from(eventImages)
    .where(eq(eventImages.eventId, eventId));
  const nextPos = posRows[0]?.nextPos ?? 0;

  const [row] = await db
    .insert(eventImages)
    .values({
      eventId,
      tenantId,
      storageKey,
      mimeType: head.contentType,
      sizeBytes: head.sizeBytes,
      position: nextPos,
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null,
    })
    .returning();
  if (!row) throw new Error('event_image insert returned no row');
  return toDTO(row);
}

export async function listEventImages(eventId: string): Promise<EventImageDTO[]> {
  const rows = await db
    .select()
    .from(eventImages)
    .where(eq(eventImages.eventId, eventId))
    .orderBy(asc(eventImages.position), asc(eventImages.createdAt));
  return rows.map(toDTO);
}

/**
 * Batch-fetch public image refs for many events at once (one query), ordered by
 * position. Returns a Map keyed by eventId; events with no images are absent.
 */
export async function imagesForEvents(eventIds: string[]): Promise<Map<string, PublicImageRef[]>> {
  const out = new Map<string, PublicImageRef[]>();
  if (eventIds.length === 0) return out;
  const rows = await db
    .select()
    .from(eventImages)
    .where(inArray(eventImages.eventId, eventIds))
    .orderBy(asc(eventImages.position), asc(eventImages.createdAt));
  const storage = getStorage();
  for (const r of rows) {
    const list = out.get(r.eventId) ?? [];
    list.push({
      url: storage.publicUrl(r.storageKey),
      position: r.position,
      width: r.width,
      height: r.height,
      focalX: r.focalX,
      focalY: r.focalY,
    });
    out.set(r.eventId, list);
  }
  return out;
}

/**
 * Fallback gallery for recurring events: photos are uploaded once (to the first
 * occurrence created), so occurrences without their own images borrow the
 * gallery of the earliest-starting occurrence in their series that has one.
 * Returns a Map keyed by seriesId; series with no images anywhere are absent.
 */
export async function imagesForSeries(
  seriesIds: string[],
): Promise<Map<string, PublicImageRef[]>> {
  const out = new Map<string, PublicImageRef[]>();
  if (seriesIds.length === 0) return out;
  const rows = await db
    .select({
      seriesId: events.seriesId,
      eventId: eventImages.eventId,
      storageKey: eventImages.storageKey,
      position: eventImages.position,
      width: eventImages.width,
      height: eventImages.height,
      focalX: eventImages.focalX,
      focalY: eventImages.focalY,
    })
    .from(eventImages)
    .innerJoin(events, eq(events.id, eventImages.eventId))
    .where(inArray(events.seriesId, seriesIds))
    .orderBy(asc(events.startsAt), asc(eventImages.position), asc(eventImages.createdAt));
  const storage = getStorage();
  const chosenEvent = new Map<string, string>();
  for (const r of rows) {
    const sid = r.seriesId!;
    if (!chosenEvent.has(sid)) chosenEvent.set(sid, r.eventId);
    if (chosenEvent.get(sid) !== r.eventId) continue;
    const list = out.get(sid) ?? [];
    list.push({
      url: storage.publicUrl(r.storageKey),
      position: r.position,
      width: r.width,
      height: r.height,
      focalX: r.focalX,
      focalY: r.focalY,
    });
    out.set(sid, list);
  }
  return out;
}

/** Delete the DB row and the underlying object. Scoped to the event. */
export async function deleteEventImage(eventId: string, imageId: string): Promise<void> {
  const row = await db.query.eventImages.findFirst({
    where: eq(eventImages.id, imageId),
  });
  if (!row || row.eventId !== eventId) {
    throw new NotFound('Image not found', 'event_image_not_found');
  }
  await getStorage().delete(row.storageKey);
  await db.delete(eventImages).where(eq(eventImages.id, imageId));
}

/**
 * Replace the gallery order wholesale. `imageIds` must be an exact permutation
 * of the event's current images — a full list rather than a "move A to N" makes
 * the call idempotent and leaves no room for a partial reorder to wedge the
 * gallery. Position 0 is the cover, so "set as cover" is this call with one id
 * spliced to the front. No unique index on `position`, so the rewrite needs no
 * intermediate renumbering pass.
 *
 * Recurring events share one gallery (see imagesForSeries), so reordering on
 * any occurrence that owns photos reorders what the whole series shows.
 */
export async function reorderEventImages(eventId: string, imageIds: string[]): Promise<EventImageDTO[]> {
  const current = await db
    .select({ id: eventImages.id })
    .from(eventImages)
    .where(eq(eventImages.eventId, eventId));
  const currentIds = new Set(current.map((r) => r.id));
  const seen = new Set<string>();
  for (const id of imageIds) {
    if (seen.has(id)) throw new BadRequest('imageIds contains duplicates', 'bad_image_order');
    if (!currentIds.has(id)) {
      throw new BadRequest('imageIds contains an image not on this event', 'bad_image_order');
    }
    seen.add(id);
  }
  if (seen.size !== currentIds.size) {
    throw new BadRequest(
      `imageIds must list all ${currentIds.size} images of this event`,
      'bad_image_order',
    );
  }

  await db.transaction(async (tx) => {
    for (const [i, id] of imageIds.entries()) {
      await tx.update(eventImages).set({ position: i }).where(eq(eventImages.id, id));
    }
  });
  return listEventImages(eventId);
}

/** Move an image's crop anchor. Values are 0..1; the DB CHECK backs this up. */
export async function setEventImageFocal(
  eventId: string,
  imageId: string,
  focal: FocalPoint,
): Promise<EventImageDTO> {
  const [row] = await db
    .update(eventImages)
    .set({ focalX: focal.focalX, focalY: focal.focalY })
    .where(and(eq(eventImages.id, imageId), eq(eventImages.eventId, eventId)))
    .returning();
  if (!row) throw new NotFound('Image not found', 'event_image_not_found');
  return toDTO(row);
}
