import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type VenueImage, venueImages } from '../db/schema/index.js';
import { BadRequest, Conflict, NotFound } from '../lib/errors.js';
import { getStorage, type PresignedUpload } from '../lib/storage.js';

/** Image content-types we accept, mapped to the key extension we store under. */
const ALLOWED_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** Hard ceilings. Venue galleries are small; these are generous safety rails. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MiB
const MAX_IMAGES_PER_VENUE = 12;

/**
 * Intrinsic pixel size of an upload, reported by the browser. R2's HEAD gives
 * us bytes and content-type but not dimensions, so unlike those two this is
 * client-supplied. It is cosmetic only (aspect-correct boxes, reserved layout
 * space) and never feeds authz, billing, or storage accounting — the API just
 * range-checks it. Omitted for uploads whose dimensions we couldn't read.
 */
export interface ImageDimensions {
  width: number;
  height: number;
}

/** Crop anchor in 0..1 image space; 0.5/0.5 is a plain centre crop. */
export interface FocalPoint {
  focalX: number;
  focalY: number;
}

/** Wire shape: the stored row plus the public URL the frontend renders. */
export interface VenueImageDTO {
  id: string;
  venueId: string;
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

function toDTO(row: VenueImage): VenueImageDTO {
  return {
    id: row.id,
    venueId: row.venueId,
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

/** Object-key prefix that scopes every image to its venue. */
function venuePrefix(venueId: string): string {
  return `venues/${venueId}/`;
}

/**
 * Step 1 of upload: hand the client a presigned PUT it uploads directly to R2.
 * We pick the key (the client can't), so a finalized image always lands under
 * the venue's prefix. Enforces the per-venue cap up front.
 */
export async function presignVenueImageUpload(
  venueId: string,
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
    .from(venueImages)
    .where(eq(venueImages.venueId, venueId));
  const count = countRows[0]?.count ?? 0;
  if (count >= MAX_IMAGES_PER_VENUE) {
    throw new Conflict(
      `Venue already has the maximum of ${MAX_IMAGES_PER_VENUE} images`,
      'too_many_images',
    );
  }

  const key = `${venuePrefix(venueId)}${randomUUID()}.${ext}`;
  return getStorage().presignUpload({ key, contentType });
}

/**
 * Step 2 of upload: the client tells us it finished PUTting `storageKey`. We
 * HEAD the object to verify it exists and to read the REAL size/type from R2
 * (never trusting the client), then persist the row.
 */
export async function finalizeVenueImage(
  tenantId: string,
  venueId: string,
  storageKey: string,
  dimensions?: ImageDimensions,
): Promise<VenueImageDTO> {
  if (!storageKey.startsWith(venuePrefix(venueId))) {
    throw new BadRequest('storageKey does not belong to this venue', 'bad_storage_key');
  }

  const head = await getStorage().head(storageKey);
  if (!head) {
    throw new BadRequest('No uploaded object found for that storageKey', 'upload_not_found');
  }
  if (!ALLOWED_TYPES[head.contentType]) {
    // The uploaded object's actual type isn't an allowed image — drop it.
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

  // Append to the end of the gallery (max position + 1, or 0 when empty).
  const posRows = await db
    .select({ nextPos: sql<number>`coalesce(max(${venueImages.position}) + 1, 0)::int` })
    .from(venueImages)
    .where(eq(venueImages.venueId, venueId));
  const nextPos = posRows[0]?.nextPos ?? 0;

  const [row] = await db
    .insert(venueImages)
    .values({
      venueId,
      tenantId,
      storageKey,
      mimeType: head.contentType,
      sizeBytes: head.sizeBytes,
      position: nextPos,
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null,
    })
    .returning();
  if (!row) throw new Error('venue_image insert returned no row');
  return toDTO(row);
}

export async function listVenueImages(venueId: string): Promise<VenueImageDTO[]> {
  const rows = await db
    .select()
    .from(venueImages)
    .where(eq(venueImages.venueId, venueId))
    .orderBy(asc(venueImages.position), asc(venueImages.createdAt));
  return rows.map(toDTO);
}

/** Public image reference embedded in consumer-facing responses. */
export interface PublicImageRef {
  url: string;
  position: number;
  /** Null on rows uploaded before dimensions were captured. */
  width: number | null;
  height: number | null;
  focalX: number;
  focalY: number;
}

/**
 * Batch-fetch public image refs for many venues at once (one query), ordered by
 * position. Returns a Map keyed by venueId; venues with no images are absent
 * (callers treat that as []). Lets the consumer endpoints enrich a whole list
 * without an N+1.
 */
export async function imagesForVenues(venueIds: string[]): Promise<Map<string, PublicImageRef[]>> {
  const out = new Map<string, PublicImageRef[]>();
  if (venueIds.length === 0) return out;
  const rows = await db
    .select()
    .from(venueImages)
    .where(inArray(venueImages.venueId, venueIds))
    .orderBy(asc(venueImages.position), asc(venueImages.createdAt));
  const storage = getStorage();
  for (const r of rows) {
    const list = out.get(r.venueId) ?? [];
    list.push({
      url: storage.publicUrl(r.storageKey),
      position: r.position,
      width: r.width,
      height: r.height,
      focalX: r.focalX,
      focalY: r.focalY,
    });
    out.set(r.venueId, list);
  }
  return out;
}

/** Delete the DB row and the underlying object. Scoped to the venue. */
export async function deleteVenueImage(venueId: string, imageId: string): Promise<void> {
  const row = await db.query.venueImages.findFirst({
    where: eq(venueImages.id, imageId),
  });
  if (!row || row.venueId !== venueId) {
    throw new NotFound('Image not found', 'venue_image_not_found');
  }
  await getStorage().delete(row.storageKey);
  await db.delete(venueImages).where(eq(venueImages.id, imageId));
}

/**
 * Replace the gallery order wholesale. `imageIds` must be an exact permutation
 * of the venue's current images — a full list rather than a "move A to N" makes
 * the call idempotent and leaves no room for a partial reorder to wedge the
 * gallery. Position 0 is the cover, so "set as cover" is this call with one id
 * spliced to the front. No unique index on `position`, so the rewrite needs no
 * intermediate renumbering pass.
 */
export async function reorderVenueImages(venueId: string, imageIds: string[]): Promise<VenueImageDTO[]> {
  const current = await db
    .select({ id: venueImages.id })
    .from(venueImages)
    .where(eq(venueImages.venueId, venueId));
  const currentIds = new Set(current.map((r) => r.id));
  const seen = new Set<string>();
  for (const id of imageIds) {
    if (seen.has(id)) throw new BadRequest('imageIds contains duplicates', 'bad_image_order');
    if (!currentIds.has(id)) {
      throw new BadRequest('imageIds contains an image not on this venue', 'bad_image_order');
    }
    seen.add(id);
  }
  if (seen.size !== currentIds.size) {
    throw new BadRequest(
      `imageIds must list all ${currentIds.size} images of this venue`,
      'bad_image_order',
    );
  }

  await db.transaction(async (tx) => {
    for (const [i, id] of imageIds.entries()) {
      await tx.update(venueImages).set({ position: i }).where(eq(venueImages.id, id));
    }
  });
  return listVenueImages(venueId);
}

/** Move an image's crop anchor. Values are 0..1; the DB CHECK backs this up. */
export async function setVenueImageFocal(
  venueId: string,
  imageId: string,
  focal: FocalPoint,
): Promise<VenueImageDTO> {
  const [row] = await db
    .update(venueImages)
    .set({ focalX: focal.focalX, focalY: focal.focalY })
    .where(and(eq(venueImages.id, imageId), eq(venueImages.venueId, venueId)))
    .returning();
  if (!row) throw new NotFound('Image not found', 'venue_image_not_found');
  return toDTO(row);
}
