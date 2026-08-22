import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { BadRequest, NotFound } from '../lib/errors.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
import { requireTenantMembership } from '../middleware/tenant_context.js';
import { getVenueById } from '../services/venue_service.js';
import {
  deleteVenueImage,
  finalizeVenueImage,
  listVenueImages,
  presignVenueImageUpload,
  reorderVenueImages,
  setVenueImageFocal,
} from '../services/venue_image_service.js';

const presignSchema = z.object({
  contentType: z.string().min(1).max(100),
});

const finalizeSchema = z.object({
  storageKey: z.string().min(1).max(512),
  // Client-reported (R2's HEAD can't give pixel dimensions). Cosmetic only, so
  // we range-check rather than verify — see ImageDimensions in the service.
  width: z.number().int().min(1).max(20000).optional(),
  height: z.number().int().min(1).max(20000).optional(),
});

const orderSchema = z.object({
  imageIds: z.array(z.string().uuid()).min(1).max(12),
});

const focalSchema = z.object({
  focalX: z.number().min(0).max(1),
  focalY: z.number().min(0).max(1),
});

/** Resolve the venue and assert the caller belongs to its tenant. */
async function authorizeVenue(req: FastifyRequest) {
  const { id } = req.params as { id: string };
  const venue = await getVenueById(id);
  if (!venue) throw new NotFound('Venue not found', 'venue_not_found');
  const user = await currentUser(req);
  await requireTenantMembership(user.id, venue.tenantId);
  return venue;
}

export const venueImageRoutes: FastifyPluginAsync = async (app) => {
  // Step 1: get a presigned PUT the client uploads the file directly to.
  app.post('/v1/venues/:id/images/upload-presign', { preHandler: requireAuth }, async (req) => {
    const parsed = presignSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequest('Invalid presign payload', 'bad_request', { issues: parsed.error.issues });
    }
    const venue = await authorizeVenue(req);
    return presignVenueImageUpload(venue.id, parsed.data.contentType);
  });

  // Step 2: confirm the upload finished; we HEAD R2 and persist the record.
  app.post('/v1/venues/:id/images', { preHandler: requireAuth }, async (req) => {
    const parsed = finalizeSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequest('Invalid finalize payload', 'bad_request', { issues: parsed.error.issues });
    }
    const venue = await authorizeVenue(req);
    const { storageKey, width, height } = parsed.data;
    const dimensions = width && height ? { width, height } : undefined;
    return finalizeVenueImage(venue.tenantId, venue.id, storageKey, dimensions);
  });

  app.get('/v1/venues/:id/images', { preHandler: requireAuth }, async (req) => {
    const venue = await authorizeVenue(req);
    return listVenueImages(venue.id);
  });

  // Full-list reorder (position 0 = cover). See reorderVenueImages for why the
  // payload is the whole gallery rather than a single move.
  app.put('/v1/venues/:id/images/order', { preHandler: requireAuth }, async (req) => {
    const parsed = orderSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequest('Invalid order payload', 'bad_request', { issues: parsed.error.issues });
    }
    const venue = await authorizeVenue(req);
    return reorderVenueImages(venue.id, parsed.data.imageIds);
  });

  // Move the crop anchor used by the consumer card crop.
  app.patch('/v1/venues/:id/images/:imageId', { preHandler: requireAuth }, async (req) => {
    const parsed = focalSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequest('Invalid focal payload', 'bad_request', { issues: parsed.error.issues });
    }
    const { imageId } = req.params as { imageId: string };
    const venue = await authorizeVenue(req);
    return setVenueImageFocal(venue.id, imageId, parsed.data);
  });

  app.delete('/v1/venues/:id/images/:imageId', { preHandler: requireAuth }, async (req) => {
    const { imageId } = req.params as { imageId: string };
    const venue = await authorizeVenue(req);
    await deleteVenueImage(venue.id, imageId);
    return { ok: true };
  });
};
