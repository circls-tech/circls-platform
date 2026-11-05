import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env } from '../config/env.js';
import { SDUI_APPS } from '../db/schema/screen_layouts.js';
import { getPlatformTenantId } from '../lib/authz/platform_tenant.js';
import { BadRequest, NotFound, Unauthorized } from '../lib/errors.js';
import { SDUI_PLATFORMS } from '../lib/sdui/schema.js';
import type { ClientInfo } from '../lib/sdui/select.js';
import { assertCap } from '../middleware/require_cap.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
import { requireTenantMembership } from '../middleware/tenant_context.js';
import { getDraft, getManifest, getPublishedScreen, rowToScreen } from '../services/screens_service.js';

/** Static segments under /v1/screens/:app that a screen key may not shadow. */
const RESERVED_KEYS = ['manifest', 'flags', 'update'];

export const appParam = z.enum(SDUI_APPS);
export const keyParam = z
  .string()
  .regex(/^[a-z0-9_]{1,64}$/, 'Screen key: a-z, 0-9 and _ only (max 64)')
  .refine((k) => !RESERVED_KEYS.includes(k), 'Reserved screen key');

const clientQuery = z.object({
  platform: z.enum(SDUI_PLATFORMS).optional(),
  build: z.coerce.number().int().nonnegative().optional(),
  schema: z.coerce.number().int().positive().default(1),
  draft: z.enum(['1', 'true']).optional(),
});

const CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=300';

function parseParams<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new BadRequest('Invalid request', 'bad_request', { issues: parsed.error.issues });
  }
  return parsed.data;
}

function etagMatches(req: FastifyRequest, etag: string): boolean {
  const header = req.headers['if-none-match'];
  if (!header) return false;
  return header
    .split(',')
    .map((t) => t.trim().replace(/^W\//, ''))
    .some((t) => t === etag || t === '*');
}

/**
 * Server-driven UI, public side (docs/SDUI.md): the manifest an app polls on
 * launch (flags, the version of every screen it may render, the update
 * notice) and the screen documents themselves. Unauthenticated; a platform
 * admin with `?draft=1` gets the draft instead — the admin preview path.
 */
export const screenRoutes: FastifyPluginAsync = async (app) => {
  const publicLimit = {
    rateLimit: { max: env.RATE_LIMIT_PUBLIC_MAX, timeWindow: '1 minute' },
  } as const;

  app.get('/v1/screens/:app/manifest', { config: publicLimit }, async (req, reply) => {
    const { app: sduiApp } = parseParams(z.object({ app: appParam }), req.params);
    const q = parseParams(clientQuery, req.query);
    const client: ClientInfo = { platform: q.platform, build: q.build, schema: q.schema };
    reply.header('Cache-Control', CACHE_CONTROL);
    return getManifest(sduiApp, client);
  });

  app.get('/v1/screens/:app/:key', { config: publicLimit }, async (req, reply: FastifyReply) => {
    const { app: sduiApp, key } = parseParams(z.object({ app: appParam, key: keyParam }), req.params);
    const q = parseParams(clientQuery, req.query);

    if (q.draft) {
      // The admin preview: only a signed-in member of the Circls tenant, and
      // never cached — it changes with every save.
      if (!req.headers.authorization) throw new Unauthorized();
      await requireAuth(req, reply);
      const user = await currentUser(req);
      const ctx = await requireTenantMembership(user.id, await getPlatformTenantId());
      assertCap(ctx, 'admin.content.read');
      const draft = await getDraft(sduiApp, key);
      if (!draft) throw new NotFound('No draft for this screen', 'not_found');
      reply.header('Cache-Control', 'no-store');
      reply.header('ETag', `"${sduiApp}.${key}.${draft.version}.draft"`);
      return rowToScreen(draft);
    }

    const client: ClientInfo = { platform: q.platform, build: q.build, schema: q.schema };
    const row = await getPublishedScreen(sduiApp, key, client);
    if (!row) throw new NotFound('No published layout for this screen', 'not_found');
    const etag = `"${sduiApp}.${key}.${row.version}"`;
    reply.header('ETag', etag);
    reply.header('Cache-Control', CACHE_CONTROL);
    if (etagMatches(req, etag)) {
      return reply.code(304).send();
    }
    return rowToScreen(row);
  });
};
