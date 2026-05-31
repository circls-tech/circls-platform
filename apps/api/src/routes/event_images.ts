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
} from '../services/event_image_service.js';
import { getEventById } from '../services/events_service.js';

const presignSchema = z.object({
  contentType: z.string().min(1).max(100),
});

const finalizeSchema = z.object({
  storageKey: z.string().min(1).max(512),
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
    return finalizeEventImage(event.tenantId, event.id, parsed.data.storageKey);
  });

  app.get('/v1/events/:id/images', { preHandler: requireAuth }, async (req) => {
    const event = await authorizeEvent(req);
    return listEventImages(event.id);
  });

  app.delete('/v1/events/:id/images/:imageId', { preHandler: requireAuth }, async (req) => {
    const { imageId } = req.params as { imageId: string };
    const event = await authorizeEvent(req);
    await deleteEventImage(event.id, imageId);
    return { ok: true };
  });
};
