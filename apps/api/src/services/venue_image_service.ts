import { randomUUID } from 'node:crypto';
import { asc, eq, sql } from 'drizzle-orm';
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

/** Wire shape: the stored row plus the public URL the frontend renders. */
export interface VenueImageDTO {
  id: string;
  venueId: string;
  storageKey: string;
  url: string;
  mimeType: string;
  sizeBytes: number | null;
  position: number;
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
