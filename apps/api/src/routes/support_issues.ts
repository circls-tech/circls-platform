import { desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { supportIssues } from '../db/schema/support_issues.js';
import { BadRequest } from '../lib/errors.js';
import { getPlatformTenantId } from '../lib/authz/platform_tenant.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
import { requireTenantMembership } from '../middleware/tenant_context.js';
import { assertCap } from '../middleware/require_cap.js';

const createIssueSchema = z.object({
  message: z.string().min(10).max(2000),
});

const updateIssueSchema = z.object({
  status: z.enum(['unresolved', 'in_progress', 'backlog', 'resolved']).optional(),
  priority: z.enum(['low', 'medium', 'high']).optional(),
});

export const supportIssueRoutes: FastifyPluginAsync = async (app) => {
  // Partner: submit a support issue
  app.post('/v1/support/issues', { preHandler: requireAuth }, async (req) => {
    const parsed = createIssueSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequest('Invalid issue payload', 'bad_request', { issues: parsed.error.issues });
    }
    const user = await currentUser(req);
    const [issue] = await db
      .insert(supportIssues)
      .values({ userId: user.id, message: parsed.data.message })
      .returning();
    return issue;
  });

  // Admin: list all support issues
  app.get('/v1/admin/support-issues', { preHandler: requireAuth }, async (req) => {
    const user = await currentUser(req);
    const platformTenantId = await getPlatformTenantId();
    const ctx = await requireTenantMembership(user.id, platformTenantId);
    assertCap(ctx, 'admin.tenants.read');

    const rows = await db
      .select()
      .from(supportIssues)
      .orderBy(desc(supportIssues.createdAt));
    return rows;
  });

  // Admin: update an issue's status / priority
  app.patch('/v1/admin/support-issues/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = updateIssueSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequest('Invalid update payload', 'bad_request', { issues: parsed.error.issues });
    }
    const user = await currentUser(req);
    const platformTenantId = await getPlatformTenantId();
    const ctx = await requireTenantMembership(user.id, platformTenantId);
    assertCap(ctx, 'admin.tenants.read');

    const updates: Partial<typeof supportIssues.$inferInsert> = {};
    if (parsed.data.status) updates.status = parsed.data.status;
    if (parsed.data.priority) updates.priority = parsed.data.priority;

    const [updated] = await db
      .update(supportIssues)
      .set(updates)
      .where(eq(supportIssues.id, id))
      .returning();
    return updated;
  });
};
