import { and, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { supportIssues } from '../db/schema/support_issues.js';
import { tenantMembers, tenants } from '../db/schema/index.js';
import { AppError, BadRequest, Forbidden, NotFound } from '../lib/errors.js';
import { getPlatformTenantId } from '../lib/authz/platform_tenant.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
import { requireTenantMembership } from '../middleware/tenant_context.js';
import { assertCap } from '../middleware/require_cap.js';
import {
  listAdminSupportIssues,
  listConsumerConcerns,
} from '../services/support_service.js';

const createIssueSchema = z.object({
  message: z.string().min(10).max(2000),
});

const updateIssueSchema = z
  .object({
    status: z.enum(['unresolved', 'in_progress', 'backlog', 'resolved']).optional(),
    priority: z.enum(['low', 'medium', 'high']).optional(),
  })
  .refine((d) => d.status !== undefined || d.priority !== undefined, {
    message: 'Nothing to update',
  });

// Consumer Help chatbot concern category (#114) — kept for the admin list filter.
const concernCategory = z.enum([
  'booking_issue',
  'refund_request',
  'reschedule',
  'venue_question',
  'payment',
  'other',
]);

// Admin list filters (#114): all optional; absent = no filter.
const adminListQuery = z.object({
  source: z.enum(['partner_help', 'consumer_chatbot']).optional(),
  category: concernCategory.optional(),
  status: z.enum(['unresolved', 'in_progress', 'backlog', 'resolved']).optional(),
});

export const supportIssueRoutes: FastifyPluginAsync = async (app) => {
  // Partner: submit a support issue (writes source = partner_help by default).
  // Partners only — a member of some organisation other than Circls itself,
  // suspended ones included, since that is who most needs to reach support.
  app.post('/v1/support/issues', { preHandler: requireAuth }, async (req) => {
    const parsed = createIssueSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequest('Invalid issue payload', 'bad_request', { issues: parsed.error.issues });
    }
    const user = await currentUser(req);
    const [partner] = await db
      .select({ tenantId: tenantMembers.tenantId })
      .from(tenantMembers)
      .innerJoin(tenants, eq(tenants.id, tenantMembers.tenantId))
      .where(and(eq(tenantMembers.userId, user.id), eq(tenants.isPlatform, false)))
      .limit(1);
    if (!partner) {
      throw new Forbidden('Only partner organisations can raise support issues', 'partner_only');
    }
    const [issue] = await db
      .insert(supportIssues)
      .values({ userId: user.id, message: parsed.data.message })
      .returning();
    return issue;
  });

  // Consumer concern intake is GONE (support→threads design, 2026-07-18): the
  // Help widget now creates a private question thread instead —
  // POST /v1/consumer/questions with `origin: 'support'`. The GET variants
  // below stay for historical reads; partner + admin issue routes are intact.
  app.post('/v1/consumer/support/concerns', async () => {
    throw new AppError(
      'gone',
      'Consumer concerns are now question threads — POST /v1/consumer/questions with origin "support"',
      410,
    );
  });

  // Consumer: list the caller's own past concerns (#114).
  app.get('/v1/consumer/support/concerns', { preHandler: requireAuth }, async (req) => {
    const user = await currentUser(req);
    return { rows: await listConsumerConcerns(user.id) };
  });

  // Admin: list all support issues (partner + consumer) with optional filters.
  app.get('/v1/admin/support-issues', { preHandler: requireAuth }, async (req) => {
    const user = await currentUser(req);
    const platformTenantId = await getPlatformTenantId();
    const ctx = await requireTenantMembership(user.id, platformTenantId);
    assertCap(ctx, 'admin.support.read');

    const parsed = adminListQuery.safeParse(req.query);
    if (!parsed.success) {
      throw new BadRequest('Invalid filter', 'bad_request', { issues: parsed.error.issues });
    }
    return listAdminSupportIssues({
      source: parsed.data.source,
      category: parsed.data.category,
      status: parsed.data.status,
    });
  });

  // Admin: update an issue's status / priority (works for both sources).
  app.patch('/v1/admin/support-issues/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    if (!z.string().uuid().safeParse(id).success) {
      throw new NotFound('Support issue not found', 'support_issue_not_found');
    }
    const parsed = updateIssueSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequest('Invalid update payload', 'bad_request', { issues: parsed.error.issues });
    }
    const user = await currentUser(req);
    const platformTenantId = await getPlatformTenantId();
    const ctx = await requireTenantMembership(user.id, platformTenantId);
    assertCap(ctx, 'admin.support.write');

    const updates: Partial<typeof supportIssues.$inferInsert> = {};
    if (parsed.data.status) updates.status = parsed.data.status;
    if (parsed.data.priority) updates.priority = parsed.data.priority;

    const [updated] = await db
      .update(supportIssues)
      .set(updates)
      .where(eq(supportIssues.id, id))
      .returning();
    if (!updated) throw new NotFound('Support issue not found', 'support_issue_not_found');
    return updated;
  });
};
