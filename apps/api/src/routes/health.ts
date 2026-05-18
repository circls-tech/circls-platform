import type { FastifyPluginAsync } from 'fastify';

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/v1/health', async () => ({ ok: true }));
  app.get('/v1/health/live', async () => ({ ok: true }));
};
