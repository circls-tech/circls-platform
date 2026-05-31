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
} from '../services/venue_image_service.js';

const presignSchema = z.object({
  contentType: z.string().min(1).max(100),
});

const finalizeSchema = z.object({
  storageKey: z.string().min(1).max(512),
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
    return finalizeVenueImage(venue.tenantId, venue.id, parsed.data.storageKey);
  });

  app.get('/v1/venues/:id/images', { preHandler: requireAuth }, async (req) => {
    const venue = await authorizeVenue(req);
    return listVenueImages(venue.id);
  });

  app.delete('/v1/venues/:id/images/:imageId', { preHandler: requireAuth }, async (req) => {
    const { imageId } = req.params as { imageId: string };
    const venue = await authorizeVenue(req);
    await deleteVenueImage(venue.id, imageId);
    return { ok: true };
  });
};
