/**
 * Questions threads routes — consumer + partner + admin surfaces in one file
 * (support_issues.ts precedent). Design doc: docs/superpowers/specs/
 * 2026-07-18-questions-threads-design.md §3.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env } from '../config/env.js';
import { BadRequest } from '../lib/errors.js';
import { getPlatformTenantId } from '../lib/authz/platform_tenant.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
import { requireTenantMembership } from '../middleware/tenant_context.js';
import { assertCap } from '../middleware/require_cap.js';
import { getThreadContext } from '../services/questions_context_service.js';
import {
  addCirclsMessage,
  addConsumerMessage,
  addOrgMessage,
  ANONYMOUS_RELATION,
  countOpenThreads,
  createSupportThread,
  createThread,
  getThreadDetailForStaff,
  getThreadDetailForViewer,
  getThreadTenantId,
  listMyThreads,
  listPublicThreads,
  listStaffThreads,
  resolveViewerRelation,
  setMessageHidden,
  setStatusAsAuthor,
  setStatusAsStaff,
  setThreadArchived,
} from '../services/questions_service.js';

const subjectType = z.enum(['event', 'arena', 'membership']);
/** Staff filters additionally accept `general` (support threads, no subject). */
const staffSubjectType = z.enum(['event', 'arena', 'membership', 'general']);
const threadStatus = z.enum(['open', 'answered', 'closed']);
const visibility = z.enum(['public', 'private']);
const threadOrigin = z.enum(['forum', 'support']);

const cursorQuery = {
  cursor: z.string().min(3).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
};

const publicListQuery = z.object({
  subjectType,
  subjectId: z.string().uuid(),
  ...cursorQuery,
});

// `/mine` supports an optional subject filter — both keys or neither.
const mineListQuery = z
  .object({
    subjectType: subjectType.optional(),
    subjectId: z.string().uuid().optional(),
    ...cursorQuery,
  })
  .refine((q) => (q.subjectType === undefined) === (q.subjectId === undefined), {
    message: 'subjectType and subjectId must be provided together',
  });

const messageBody = z.object({
  body: z.string().trim().min(1).max(2000),
});

// Forum ask (unchanged contract; `origin: 'forum'` may be sent explicitly).
// `.strict()` keeps support-intake fields (category/bookingId/flowAnswers)
// off this shape — and vice versa below.
const createThreadBody = z
  .object({
    origin: z.literal('forum').optional(),
    subjectType,
    subjectId: z.string().uuid(),
    visibility,
    body: z.string().trim().min(1).max(2000),
  })
  .strict();

// Support intake (Help-widget interview): no subjectType/visibility from the
// client — the server derives the subject from the booking (or `general`) and
// forces `private`.
const flowAnswerSchema = z.object({
  question: z.string().min(1).max(500),
  answer: z.string().min(1).max(500),
});
const createSupportThreadBody = z
  .object({
    origin: z.literal('support'),
    category: z.enum([
      'booking_issue',
      'refund_request',
      'reschedule',
      'venue_question',
      'payment',
      'other',
    ]),
    body: z.string().trim().min(1).max(2000),
    bookingId: z.string().uuid().optional(),
    flowAnswers: z.array(flowAnswerSchema).max(50).optional(),
  })
  .strict();

/** Author can mark answered/closed; reopening = the org/admin surfaces. */
const authorPatchBody = z.object({ status: z.enum(['answered', 'closed']) });
const staffPatchBody = z.object({ status: threadStatus });

const staffListQuery = z.object({
  status: threadStatus.optional(),
  visibility: visibility.optional(),
  subjectType: staffSubjectType.optional(),
  /** Filter by intake channel: organic asks vs Help-interview support threads. */
  origin: threadOrigin.optional(),
  /** 'true' selects the archived view; default 'false' (active threads only). */
  archived: z.enum(['true', 'false']).optional(),
  ...cursorQuery,
});

const adminListQuery = staffListQuery.extend({
  tenantId: z.string().uuid().optional(),
});

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new BadRequest('Invalid payload', 'bad_request', { issues: parsed.error.issues });
  }
  return parsed.data;
}

export const questionRoutes: FastifyPluginAsync = async (app) => {
  // Anonymous browse shares the stricter public rate-limit ceiling used by the
  // consumer browse endpoints (M6).
  const publicLimit = {
    rateLimit: { max: env.RATE_LIMIT_PUBLIC_MAX, timeWindow: '1 minute' },
  } as const;

  /** Optional auth: verify the bearer token when present, else stay anonymous. */
  async function maybeAuthedUserId(req: FastifyRequest): Promise<string | null> {
    if (!req.headers.authorization) return null;
    await requireAuth(req, undefined as never);
    const user = await currentUser(req);
    return user.id;
  }

  // ── Consumer ────────────────────────────────────────────────────────────────

  // Public threads on a subject — no auth required (signed-out browse).
  app.get('/v1/consumer/questions', { config: publicLimit }, async (req) => {
    const q = parseOrThrow(publicListQuery, req.query);
    return listPublicThreads({
      subjectType: q.subjectType,
      subjectId: q.subjectId,
      cursor: q.cursor,
      limit: q.limit,
    });
  });

  // The caller's own threads (both visibilities), optional subject filter.
  app.get('/v1/consumer/questions/mine', { preHandler: requireAuth }, async (req) => {
    const q = parseOrThrow(mineListQuery, req.query);
    const user = await currentUser(req);
    return listMyThreads({
      userId: user.id,
      subjectType: q.subjectType,
      subjectId: q.subjectId,
      cursor: q.cursor,
      limit: q.limit,
    });
  });

  // Ask a question (starts a thread). Two intake shapes, discriminated on
  // `origin`: the forum ask (default; subject must be publicly visible) and
  // the Help-widget support intake (`origin: 'support'`; server-derived
  // subject, forced-private).
  app.post('/v1/consumer/questions', { preHandler: requireAuth }, async (req) => {
    const raw = req.body as Record<string, unknown> | null | undefined;
    const user = await currentUser(req);
    if (raw && raw['origin'] === 'support') {
      const body = parseOrThrow(createSupportThreadBody, req.body);
      return createSupportThread({
        userId: user.id,
        category: body.category,
        body: body.body,
        bookingId: body.bookingId,
        flowAnswers: body.flowAnswers,
      });
    }
    const body = parseOrThrow(createThreadBody, req.body);
    return createThread({
      userId: user.id,
      subjectType: body.subjectType,
      subjectId: body.subjectId,
      visibility: body.visibility,
      body: body.body,
    });
  });

  // Thread detail. Public: anyone (auth optional). Private: author/org/circls
  // only — everyone else 404s (no existence leak).
  app.get('/v1/consumer/questions/:threadId', { config: publicLimit }, async (req) => {
    const { threadId } = parseOrThrow(
      z.object({ threadId: z.string().uuid() }),
      req.params,
    );
    const userId = await maybeAuthedUserId(req);
    if (userId === null) {
      return getThreadDetailForViewer(threadId, { userId: null, ...ANONYMOUS_RELATION });
    }
    // Signed-in: resolve the viewer's org/platform relationship against the
    // thread's tenant (404s cleanly when the thread doesn't exist), then run
    // the visibility-scoped read.
    const tenantId = await getThreadTenantId(threadId);
    const rel = await resolveViewerRelation(userId, tenantId);
    return getThreadDetailForViewer(threadId, { userId, ...rel });
  });

  // Reply on a thread (consumer surface).
  app.post(
    '/v1/consumer/questions/:threadId/messages',
    { preHandler: requireAuth },
    async (req) => {
      const { threadId } = parseOrThrow(
        z.object({ threadId: z.string().uuid() }),
        req.params,
      );
      const body = parseOrThrow(messageBody, req.body);
      const user = await currentUser(req);
      return addConsumerMessage({ threadId, userId: user.id, body: body.body });
    },
  );

  // Author-only status change: answered | closed (no reopen of closed threads).
  app.patch('/v1/consumer/questions/:threadId', { preHandler: requireAuth }, async (req) => {
    const { threadId } = parseOrThrow(
      z.object({ threadId: z.string().uuid() }),
      req.params,
    );
    const body = parseOrThrow(authorPatchBody, req.body);
    const user = await currentUser(req);
    return setStatusAsAuthor({ threadId, userId: user.id, status: body.status });
  });

  // ── Partner (org inbox) ─────────────────────────────────────────────────────

  const tenantParams = z.object({ tenantId: z.string().uuid() });
  const tenantThreadParams = tenantParams.extend({ threadId: z.string().uuid() });
  const tenantMessageParams = tenantThreadParams.extend({ messageId: z.string().uuid() });

  app.get('/v1/tenants/:tenantId/questions', { preHandler: requireAuth }, async (req) => {
    const { tenantId } = parseOrThrow(tenantParams, req.params);
    const q = parseOrThrow(staffListQuery, req.query);
    const user = await currentUser(req);
    const ctx = await requireTenantMembership(user.id, tenantId);
    assertCap(ctx, 'questions.read');
    return listStaffThreads({
      tenantId,
      status: q.status,
      visibility: q.visibility,
      subjectType: q.subjectType,
      origin: q.origin,
      archived: q.archived === 'true',
      cursor: q.cursor,
      limit: q.limit,
    });
  });

  app.get(
    '/v1/tenants/:tenantId/questions/summary',
    { preHandler: requireAuth },
    async (req) => {
      const { tenantId } = parseOrThrow(tenantParams, req.params);
      const user = await currentUser(req);
      const ctx = await requireTenantMembership(user.id, tenantId);
      assertCap(ctx, 'questions.read');
      return { openCount: await countOpenThreads(tenantId) };
    },
  );

  app.get(
    '/v1/tenants/:tenantId/questions/:threadId',
    { preHandler: requireAuth },
    async (req) => {
      const { tenantId, threadId } = parseOrThrow(tenantThreadParams, req.params);
      const user = await currentUser(req);
      const ctx = await requireTenantMembership(user.id, tenantId);
      assertCap(ctx, 'questions.read');
      return getThreadDetailForStaff(threadId, { tenantId, viewerUserId: user.id });
    },
  );

  // Resolver context panel: who the asker is, the pinned booking, and their
  // relationship with this tenant. Contact details only on private threads.
  app.get(
    '/v1/tenants/:tenantId/questions/:threadId/context',
    { preHandler: requireAuth },
    async (req) => {
      const { tenantId, threadId } = parseOrThrow(tenantThreadParams, req.params);
      const user = await currentUser(req);
      const ctx = await requireTenantMembership(user.id, tenantId);
      assertCap(ctx, 'questions.read');
      return getThreadContext(threadId, { tenantId });
    },
  );

  app.post(
    '/v1/tenants/:tenantId/questions/:threadId/messages',
    { preHandler: requireAuth },
    async (req) => {
      const { tenantId, threadId } = parseOrThrow(tenantThreadParams, req.params);
      const body = parseOrThrow(messageBody, req.body);
      const user = await currentUser(req);
      const ctx = await requireTenantMembership(user.id, tenantId);
      assertCap(ctx, 'questions.write');
      return addOrgMessage({ tenantId, threadId, userId: user.id, body: body.body });
    },
  );

  app.patch(
    '/v1/tenants/:tenantId/questions/:threadId',
    { preHandler: requireAuth },
    async (req) => {
      const { tenantId, threadId } = parseOrThrow(tenantThreadParams, req.params);
      const body = parseOrThrow(staffPatchBody, req.body);
      const user = await currentUser(req);
      const ctx = await requireTenantMembership(user.id, tenantId);
      assertCap(ctx, 'questions.write');
      return setStatusAsStaff({ threadId, tenantId, status: body.status });
    },
  );

  for (const action of ['hide', 'unhide'] as const) {
    app.post(
      `/v1/tenants/:tenantId/questions/:threadId/messages/:messageId/${action}`,
      { preHandler: requireAuth },
      async (req) => {
        const { tenantId, threadId, messageId } = parseOrThrow(tenantMessageParams, req.params);
        const user = await currentUser(req);
        const ctx = await requireTenantMembership(user.id, tenantId);
        assertCap(ctx, 'questions.write');
        return setMessageHidden({
          threadId,
          messageId,
          byUserId: user.id,
          byKind: 'org',
          hidden: action === 'hide',
          allowRoot: false,
          tenantId,
        });
      },
    );
  }

  // Archive/unarchive a whole thread (hidden from every consumer surface).
  // Unarchive is hierarchy-gated: the org can only undo its own archives.
  for (const action of ['archive', 'unarchive'] as const) {
    app.post(
      `/v1/tenants/:tenantId/questions/:threadId/${action}`,
      { preHandler: requireAuth },
      async (req) => {
        const { tenantId, threadId } = parseOrThrow(tenantThreadParams, req.params);
        const user = await currentUser(req);
        const ctx = await requireTenantMembership(user.id, tenantId);
        assertCap(ctx, 'questions.write');
        return setThreadArchived({
          threadId,
          byUserId: user.id,
          byKind: 'org',
          archived: action === 'archive',
          tenantId,
        });
      },
    );
  }

  // ── Admin (Circls) ──────────────────────────────────────────────────────────

  async function adminCtx(req: FastifyRequest, cap: 'admin.support.read' | 'admin.support.write') {
    const user = await currentUser(req);
    const platformTenantId = await getPlatformTenantId();
    const ctx = await requireTenantMembership(user.id, platformTenantId);
    assertCap(ctx, cap);
    return user;
  }

  const threadParams = z.object({ threadId: z.string().uuid() });
  const messageParams = threadParams.extend({ messageId: z.string().uuid() });

  app.get('/v1/admin/questions', { preHandler: requireAuth }, async (req) => {
    await adminCtx(req, 'admin.support.read');
    const q = parseOrThrow(adminListQuery, req.query);
    return listStaffThreads({
      tenantId: q.tenantId,
      status: q.status,
      visibility: q.visibility,
      subjectType: q.subjectType,
      origin: q.origin,
      archived: q.archived === 'true',
      cursor: q.cursor,
      limit: q.limit,
    });
  });

  app.get('/v1/admin/questions/:threadId', { preHandler: requireAuth }, async (req) => {
    const user = await adminCtx(req, 'admin.support.read');
    const { threadId } = parseOrThrow(threadParams, req.params);
    return getThreadDetailForStaff(threadId, { viewerUserId: user.id });
  });

  // Admin resolver context: cross-tenant lists + activity/support-issue
  // extras; contact details always included.
  app.get('/v1/admin/questions/:threadId/context', { preHandler: requireAuth }, async (req) => {
    await adminCtx(req, 'admin.support.read');
    const { threadId } = parseOrThrow(threadParams, req.params);
    return getThreadContext(threadId, { admin: true });
  });

  app.post(
    '/v1/admin/questions/:threadId/messages',
    { preHandler: requireAuth },
    async (req) => {
      const user = await adminCtx(req, 'admin.support.write');
      const { threadId } = parseOrThrow(threadParams, req.params);
      const body = parseOrThrow(messageBody, req.body);
      return addCirclsMessage({ threadId, userId: user.id, body: body.body });
    },
  );

  app.patch('/v1/admin/questions/:threadId', { preHandler: requireAuth }, async (req) => {
    await adminCtx(req, 'admin.support.write');
    const { threadId } = parseOrThrow(threadParams, req.params);
    const body = parseOrThrow(staffPatchBody, req.body);
    return setStatusAsStaff({ threadId, status: body.status });
  });

  for (const action of ['hide', 'unhide'] as const) {
    app.post(
      `/v1/admin/questions/:threadId/messages/:messageId/${action}`,
      { preHandler: requireAuth },
      async (req) => {
        const user = await adminCtx(req, 'admin.support.write');
        const { threadId, messageId } = parseOrThrow(messageParams, req.params);
        return setMessageHidden({
          threadId,
          messageId,
          byUserId: user.id,
          byKind: 'circls',
          hidden: action === 'hide',
          allowRoot: true,
        });
      },
    );
  }

  // Circls archive/unarchive — Circls can always unarchive (any archiver).
  for (const action of ['archive', 'unarchive'] as const) {
    app.post(
      `/v1/admin/questions/:threadId/${action}`,
      { preHandler: requireAuth },
      async (req) => {
        const user = await adminCtx(req, 'admin.support.write');
        const { threadId } = parseOrThrow(threadParams, req.params);
        return setThreadArchived({
          threadId,
          byUserId: user.id,
          byKind: 'circls',
          archived: action === 'archive',
        });
      },
    );
  }
};
