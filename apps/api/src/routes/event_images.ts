import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { BadRequest, NotFound } from '../lib/errors.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
import { requireTenantMembership } from '../middleware/tenant_context.js';
import {
  deleteEventImage,
  finalizeEventImage,
  listEventImages,
  presignEventImageUpload,
  reorderEventImages,
  setEventImageFocal,
} from '../services/event_image_service.js';
import { getEventById } from '../services/events_service.js';

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

/** Resolve the event and assert the caller belongs to its tenant. */
async function authorizeEvent(req: FastifyRequest) {
  const { id } = req.params as { id: string };
  const event = await getEventById(id);
  if (!event) throw new NotFound('Event not found', 'event_not_found');
  const user = await currentUser(req);
  await requireTenantMembership(user.id, event.tenantId);
  return event;
}

export const eventImageRoutes: FastifyPluginAsync = async (app) => {
  app.post('/v1/events/:id/images/upload-presign', { preHandler: requireAuth }, async (req) => {
    const parsed = presignSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequest('Invalid presign payload', 'bad_request', { issues: parsed.error.issues });
    }
    const event = await authorizeEvent(req);
    return presignEventImageUpload(event.id, parsed.data.contentType);
  });

  app.post('/v1/events/:id/images', { preHandler: requireAuth }, async (req) => {
    const parsed = finalizeSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequest('Invalid finalize payload', 'bad_request', { issues: parsed.error.issues });
    }
    const event = await authorizeEvent(req);
    const { storageKey, width, height } = parsed.data;
    const dimensions = width && height ? { width, height } : undefined;
    return finalizeEventImage(event.tenantId, event.id, storageKey, dimensions);
  });

  app.get('/v1/events/:id/images', { preHandler: requireAuth }, async (req) => {
    const event = await authorizeEvent(req);
    return listEventImages(event.id);
  });

  // Full-list reorder (position 0 = cover). See reorderEventImages for why the
  // payload is the whole gallery rather than a single move.
  app.put('/v1/events/:id/images/order', { preHandler: requireAuth }, async (req) => {
    const parsed = orderSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequest('Invalid order payload', 'bad_request', { issues: parsed.error.issues });
    }
    const event = await authorizeEvent(req);
    return reorderEventImages(event.id, parsed.data.imageIds);
  });

  // Move the crop anchor used by the consumer card crop.
  app.patch('/v1/events/:id/images/:imageId', { preHandler: requireAuth }, async (req) => {
    const parsed = focalSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequest('Invalid focal payload', 'bad_request', { issues: parsed.error.issues });
    }
    const { imageId } = req.params as { imageId: string };
    const event = await authorizeEvent(req);
    return setEventImageFocal(event.id, imageId, parsed.data);
  });

  app.delete('/v1/events/:id/images/:imageId', { preHandler: requireAuth }, async (req) => {
    const { imageId } = req.params as { imageId: string };
    const event = await authorizeEvent(req);
    await deleteEventImage(event.id, imageId);
    return { ok: true };
  });
};
