import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { SduiApp } from '../db/schema/screen_layouts.js';
import { getPlatformTenantId } from '../lib/authz/platform_tenant.js';
import type { Capability } from '../lib/authz/capabilities.js';
import { BadRequest } from '../lib/errors.js';
import { minBuildSchema, parseScreen } from '../lib/sdui/schema.js';
import { assertCap } from '../middleware/require_cap.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
import { requireTenantMembership } from '../middleware/tenant_context.js';
import { appParam, keyParam } from './screens.js';
import {
  deleteDraft,
  getFlags,
  getScreenDetail,
  getScreenVersion,
  getUpdateNotice,
  listScreens,
  publishDraft,
  rollbackTo,
  saveDraft,
  setFlags,
  setUpdateNotice,
} from '../services/screens_service.js';

const appParams = z.object({ app: appParam });
const screenParams = z.object({ app: appParam, key: keyParam });
const versionParams = screenParams.extend({ version: z.coerce.number().int().positive() });

const draftBody = z.object({
  body: z.unknown(),
  minBuild: minBuildSchema.optional(),
  note: z.string().max(500).optional(),
});
const rollbackBody = z.object({ version: z.number().int().positive() });
const flagsBody = z.object({
  flags: z.record(z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/), z.boolean()),
});
const updateNotice = z.object({
  minSupportedBuild: minBuildSchema,
  message: z.object({
    title: z.string().min(1).max(200),
    body: z.string().max(2000),
    url: z.string().max(2000),
  }),
});
/** `null`, or `{ update: null }`, clears the notice. */
const updateBody = z.union([updateNotice, z.null(), z.object({ update: updateNotice.nullable() })]);

function parse<T>(schema: z.ZodType<T>, value: unknown, what = 'request'): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new BadRequest(`Invalid ${what}`, 'bad_request', { issues: parsed.error.issues });
  }
  return parsed.data;
}

/**
 * Server-driven UI, admin side (admin portal → Screens): drafts, publishing,
 * rollback and history per screen, plus each app's feature flags and update
 * notice. Reads need admin.content.read, changes admin.content.write; every
 * change is audited by the service.
 */
export const adminScreensRoutes: FastifyPluginAsync = async (app) => {
  async function admin(req: FastifyRequest, cap: Capability) {
    const user = await currentUser(req);
    const ctx = await requireTenantMembership(user.id, await getPlatformTenantId());
    assertCap(ctx, cap);
    return user;
  }
  const auth = { preHandler: requireAuth } as const;

  app.get('/v1/admin/screens', auth, async (req) => {
    await admin(req, 'admin.content.read');
    const { app: sduiApp } = parse(appParams, req.query, 'query');
    return { screens: await listScreens(sduiApp) };
  });

  // Flags + update notice come before /:key so the static segment wins.
  app.get('/v1/admin/screens/:app/flags', auth, async (req) => {
    await admin(req, 'admin.content.read');
    const { app: sduiApp } = parse(appParams, req.params);
    return { app: sduiApp, flags: await getFlags(sduiApp) };
  });

  app.put('/v1/admin/screens/:app/flags', auth, async (req) => {
    const user = await admin(req, 'admin.content.write');
    const { app: sduiApp } = parse(appParams, req.params);
    const { flags } = parse(flagsBody, req.body, 'flags');
    return { app: sduiApp, flags: await setFlags(sduiApp, flags, user.id) };
  });

  app.get('/v1/admin/screens/:app/update', auth, async (req) => {
    await admin(req, 'admin.content.read');
    const { app: sduiApp } = parse(appParams, req.params);
    return { app: sduiApp, update: await getUpdateNotice(sduiApp) };
  });

  app.put('/v1/admin/screens/:app/update', auth, async (req) => {
    const user = await admin(req, 'admin.content.write');
    const { app: sduiApp } = parse(appParams, req.params);
    const body = parse(updateBody, req.body ?? null, 'update notice');
    const notice = body === null ? null : 'update' in body ? body.update : body;
    return { app: sduiApp, update: await setUpdateNotice(sduiApp, notice, user.id) };
  });

  app.get('/v1/admin/screens/:app/:key', auth, async (req) => {
    await admin(req, 'admin.content.read');
    const { app: sduiApp, key } = parse(screenParams, req.params);
    return getScreenDetail(sduiApp, key);
  });

  app.get('/v1/admin/screens/:app/:key/versions/:version', auth, async (req) => {
    await admin(req, 'admin.content.read');
    const { app: sduiApp, key, version } = parse(versionParams, req.params);
    return getScreenVersion(sduiApp, key, version);
  });

  app.put('/v1/admin/screens/:app/:key/draft', auth, async (req) => {
    const user = await admin(req, 'admin.content.write');
    const { app: sduiApp, key } = parse(screenParams, req.params);
    const input = parse(draftBody, req.body, 'draft');
    const screen = parseScreen(input.body, { app: sduiApp, key });
    if (!screen.ok) {
      throw new BadRequest('Invalid screen document', 'invalid_screen', { issues: screen.issues });
    }
    return saveDraft(sduiApp, key, { body: screen.screen, minBuild: input.minBuild, note: input.note }, user.id);
  });

  app.delete('/v1/admin/screens/:app/:key/draft', auth, async (req, reply) => {
    const user = await admin(req, 'admin.content.write');
    const { app: sduiApp, key } = parse(screenParams, req.params);
    await deleteDraft(sduiApp, key, user.id);
    return reply.code(204).send();
  });

  app.post('/v1/admin/screens/:app/:key/publish', auth, async (req) => {
    const user = await admin(req, 'admin.content.write');
    const { app: sduiApp, key } = parse(screenParams, req.params);
    return publishDraft(sduiApp, key, user.id);
  });

  app.post('/v1/admin/screens/:app/:key/rollback', auth, async (req) => {
    const user = await admin(req, 'admin.content.write');
    const { app: sduiApp, key } = parse(screenParams, req.params);
    const { version } = parse(rollbackBody, req.body, 'rollback');
    return rollbackTo(sduiApp as SduiApp, key, version, user.id);
  });
};
