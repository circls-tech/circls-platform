/**
 * Tenant-facing read endpoint for the notifications ledger. Phase 13.
 *
 *   GET /v1/tenants/:tenantId/notifications
 *
 * Paged via opaque cursor (`<createdAtIso>|<id>`), descending by created_at.
 * Optional filters: channel, status. No write endpoints — dispatch is
 * internal-only (Phase 12/14/etc services call `notifyBooking…` directly).
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { BadRequest } from '../lib/errors.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
import { requireTenantMembership } from '../middleware/tenant_context.js';

const querySchema = z.object({
  channel: z.enum(['sms', 'email', 'whatsapp']).optional(),
  status: z.enum(['pending', 'sent', 'failed', 'skipped']).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

interface NotificationRow {
  id: string;
  channel: 'sms' | 'email' | 'whatsapp';
  status: 'pending' | 'sent' | 'failed' | 'skipped';
  recipient: string;
  templateKey: string;
  providerMessageId: string | null;
  error: string | null;
  scheduledFor: string | null;
  sentAt: string | null;
  createdAt: string;
}

interface NotificationsPage {
  rows: NotificationRow[];
  nextCursor: string | null;
}

function encodeCursor(createdAtIso: string, id: string): string {
  return `${createdAtIso}|${id}`;
}

function decodeCursor(cursor: string): { ts: string; id: string } | null {
  const idx = cursor.lastIndexOf('|');
  if (idx === -1) return null;
  const ts = cursor.slice(0, idx);
  const id = cursor.slice(idx + 1);
  if (!ts || !id) return null;
  return { ts, id };
}

export const notificationRoutes: FastifyPluginAsync = async (app) => {
  app.get('/v1/tenants/:tenantId/notifications', { preHandler: requireAuth }, async (req) => {
    const { tenantId } = req.params as { tenantId: string };
    const user = await currentUser(req);
    await requireTenantMembership(user.id, tenantId);

    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new BadRequest('Invalid query parameters', 'bad_request', {
        issues: parsed.error.issues,
      });
    }
    const { channel, status, cursor, limit: limParam } = parsed.data;
    const limit = Math.min(limParam ?? 50, 100);
    const fetchLimit = limit + 1;

    const conditions: ReturnType<typeof sql>[] = [sql`tenant_id = ${tenantId}`];
    if (channel) conditions.push(sql`channel = ${channel}::notification_channel`);
    if (status) conditions.push(sql`status = ${status}::notification_status`);
    if (cursor) {
      const decoded = decodeCursor(cursor);
      if (decoded) {
        conditions.push(
          sql`(created_at, id) < (${decoded.ts}::timestamptz, ${decoded.id}::uuid)`,
        );
      }
    }
    const where = conditions.reduce((acc, c) => sql`${acc} AND ${c}`);

    const raw = await db.execute<Record<string, unknown>>(sql`
      SELECT id, channel, status, recipient, template_key,
             provider_message_id, error, scheduled_for, sent_at, created_at
      FROM notifications
      WHERE ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT ${fetchLimit}
    `);

    const all = raw as unknown as Record<string, unknown>[];
    const hasMore = all.length > limit;
    const pageRows = hasMore ? all.slice(0, limit) : all;

    const rows: NotificationRow[] = pageRows.map((r) => ({
      id: r['id'] as string,
      channel: r['channel'] as NotificationRow['channel'],
      status: r['status'] as NotificationRow['status'],
      recipient: r['recipient'] as string,
      templateKey: r['template_key'] as string,
      providerMessageId: (r['provider_message_id'] as string | null) ?? null,
      error: (r['error'] as string | null) ?? null,
      scheduledFor: r['scheduled_for']
        ? new Date(r['scheduled_for'] as string).toISOString()
        : null,
      sentAt: r['sent_at'] ? new Date(r['sent_at'] as string).toISOString() : null,
      createdAt: new Date(r['created_at'] as string).toISOString(),
    }));

    let nextCursor: string | null = null;
    if (hasMore && pageRows.length > 0) {
      const last = pageRows[pageRows.length - 1]!;
      nextCursor = encodeCursor(
        new Date(last['created_at'] as string).toISOString(),
        last['id'] as string,
      );
    }

    const page: NotificationsPage = { rows, nextCursor };
    return page;
  });
};
