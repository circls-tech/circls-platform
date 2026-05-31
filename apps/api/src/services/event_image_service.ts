import { randomUUID } from 'node:crypto';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type EventImage, eventImages } from '../db/schema/index.js';
import { BadRequest, Conflict, NotFound } from '../lib/errors.js';
import { getStorage, type PresignedUpload } from '../lib/storage.js';
import type { PublicImageRef } from './venue_image_service.js';

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
    list.push({ url: storage.publicUrl(r.storageKey), position: r.position });
    out.set(r.eventId, list);
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
