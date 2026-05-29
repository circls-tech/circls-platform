import type { FastifyPluginAsync } from 'fastify';

/**
 * Build commit SHA, baked in at image build time via the SOURCE_COMMIT build
 * arg (Coolify injects it; the Dockerfile promotes it to a runtime ENV).
 * Surfaced on /v1/health so a deploy can be verified with a single curl —
 * no route-existence probing. Falls back to 'unknown' for local/dev runs.
 */
const COMMIT =
  process.env['SOURCE_COMMIT'] ?? process.env['GIT_COMMIT_SHA'] ?? process.env['COMMIT_SHA'] ?? 'unknown';

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/v1/health', async () => ({ ok: true, commit: COMMIT }));
  // Liveness probe — kept minimal so it never depends on build metadata.
  app.get('/v1/health/live', async () => ({ ok: true }));
};
