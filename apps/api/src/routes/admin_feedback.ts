import type { FastifyPluginAsync } from 'fastify';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { BadRequest } from '../lib/errors.js';
import { getPlatformTenantId } from '../lib/authz/platform_tenant.js';
import { assertCap } from '../middleware/require_cap.js';
import { requireAuth } from '../middleware/require_auth.js';
import { currentUser } from '../middleware/current_user.js';
import { requireTenantMembership } from '../middleware/tenant_context.js';

/**
 * Platform-admin Feedback report, GET /v1/admin/feedback: what consumers and
 * partners told us through the feedback prompts (see feedback_service).
 *
 *   - view=ratings: 1–10 ratings of events, venue visits and memberships,
 *     optionally narrowed by `kind`.
 *   - view=consumer / view=partner: the website surveys.
 *   - view=poll: answers to the event-type poll.
 *
 * Every row names who answered, with the phone (and email) snapshotted when
 * they did, so it needs admin.users.read like the Consumers report. Newest
 * first; `cursor` is the offset of the next page. The first page's `summary`
 * covers every matching answer, not just the page.
 */

const querySchema = z.object({
  view: z.enum(['ratings', 'consumer', 'partner', 'poll']),
  kind: z.enum(['event_feedback', 'venue_feedback', 'membership_feedback']).optional(),
  cursor: z.string().regex(/^\d{1,9}$/).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

type Row = Record<string, unknown>;

function iso(v: unknown): string | null {
  return v == null ? null : new Date(v as string).toISOString();
}

function num(v: unknown): number | null {
  return v == null ? null : Number(v);
}

/** Average to one decimal, null when nobody answered. */
function avg(v: unknown): number | null {
  return v == null ? null : Math.round(Number(v) * 10) / 10;
}

function person(r: Row) {
  return {
    userId: r['user_id'] as string,
    name: (r['display_name'] as string | null) ?? null,
    phone: (r['phone_e164'] as string | null) ?? null,
    email: (r['email'] as string | null) ?? null,
  };
}

export const adminFeedbackRoutes: FastifyPluginAsync = async (app) => {
  app.get('/v1/admin/feedback', { preHandler: requireAuth }, async (req) => {
    const user = await currentUser(req);
    const platformTenantId = await getPlatformTenantId();
    const ctx = await requireTenantMembership(user.id, platformTenantId);
    assertCap(ctx, 'admin.users.read');

    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new BadRequest('Invalid query', 'bad_request', { issues: parsed.error.issues });
    }
    const { view, kind } = parsed.data;
    const limit = parsed.data.limit ?? 50;
    const offset = Number(parsed.data.cursor ?? 0);
    const page = sql`order by f.created_at desc, f.id desc limit ${limit + 1} offset ${offset}`;

    const finish = <T>(rows: Row[], map: (r: Row) => T) => {
      const hasMore = rows.length > limit;
      return {
        rows: (hasMore ? rows.slice(0, limit) : rows).map(map),
        nextCursor: hasMore ? String(offset + limit) : null,
      };
    };

    if (view === 'ratings') {
      const where: SQL = kind
        ? sql`f.kind = ${kind}`
        : sql`f.kind in ('event_feedback', 'venue_feedback', 'membership_feedback')`;
      const rows = (await db.execute(sql`
        select f.id, f.kind, f.rating, f.comment, f.source, f.created_at,
               f.user_id, u.display_name, coalesce(f.phone_e164, u.phone_e164) as phone_e164,
               u.email, f.tenant_id, t.name as tenant_name,
               coalesce(ev.name, m.name, v.name) as subject_name,
               case f.kind when 'event_feedback' then ev.starts_at
                           when 'membership_feedback' then um.starts_at
                           else (select min(lower(s.time_range)) from slots s
                                 where s.booking_id = f.booking_id) end as subject_date,
               case when f.kind = 'venue_feedback' then null else v.name end as subject_place
        from user_feedback f
        join users u on u.id = f.user_id
        left join tenants t on t.id = f.tenant_id
        left join events ev on ev.id = f.event_id
        left join memberships m on m.id = f.membership_id
        left join user_memberships um on um.id = f.user_membership_id
        left join venues v on v.id = f.venue_id
        where ${where}
        ${page}
      `)) as unknown as Row[];
      const out = finish(rows, (r) => ({
        id: r['id'] as string,
        kind: r['kind'] as string,
        rating: Number(r['rating']),
        comment: (r['comment'] as string | null) ?? null,
        source: r['source'] as string,
        createdAt: iso(r['created_at']),
        person: person(r),
        tenant: r['tenant_id']
          ? { id: r['tenant_id'] as string, name: r['tenant_name'] as string }
          : null,
        subject: {
          name: (r['subject_name'] as string | null) ?? null,
          place: (r['subject_place'] as string | null) ?? null,
          date: iso(r['subject_date']),
        },
      }));
      const [s] = (await db.execute(sql`
        select count(*) as count, avg(f.rating) as average,
               count(*) filter (where f.kind = 'event_feedback') as event_count,
               avg(f.rating) filter (where f.kind = 'event_feedback') as event_average,
               count(*) filter (where f.kind = 'venue_feedback') as venue_count,
               avg(f.rating) filter (where f.kind = 'venue_feedback') as venue_average,
               count(*) filter (where f.kind = 'membership_feedback') as membership_count,
               avg(f.rating) filter (where f.kind = 'membership_feedback') as membership_average
        from user_feedback f where ${where}
      `)) as unknown as Row[];
      return {
        view,
        ...out,
        summary: {
          count: Number(s?.['count'] ?? 0),
          average: avg(s?.['average']),
          events: { count: Number(s?.['event_count'] ?? 0), average: avg(s?.['event_average']) },
          venues: { count: Number(s?.['venue_count'] ?? 0), average: avg(s?.['venue_average']) },
          memberships: {
            count: Number(s?.['membership_count'] ?? 0),
            average: avg(s?.['membership_average']),
          },
        },
      };
    }

    if (view === 'poll') {
      const rows = (await db.execute(sql`
        select f.id, f.question, f.answer, f.comment as other, f.source, f.created_at,
               f.user_id, u.display_name, coalesce(f.phone_e164, u.phone_e164) as phone_e164, u.email
        from user_feedback f
        join users u on u.id = f.user_id
        where f.kind = 'event_type_preference'
        ${page}
      `)) as unknown as Row[];
      const out = finish(rows, (r) => ({
        id: r['id'] as string,
        question: r['question'] as string,
        answer: r['answer'] as string,
        /** What they typed when they chose "Other". */
        other: (r['other'] as string | null) ?? null,
        source: r['source'] as string,
        createdAt: iso(r['created_at']),
        person: person(r),
      }));
      const answers = (await db.execute(sql`
        select f.answer, count(*) as count from user_feedback f
        where f.kind = 'event_type_preference'
        group by f.answer order by count(*) desc, f.answer
      `)) as unknown as Row[];
      return {
        view,
        ...out,
        summary: {
          count: answers.reduce((n, a) => n + Number(a['count']), 0),
          answers: answers.map((a) => ({ answer: a['answer'] as string, count: Number(a['count']) })),
        },
      };
    }

    // The website surveys.
    const rows = (await db.execute(sql`
      select f.*, u.display_name, coalesce(f.phone_e164, u.phone_e164) as phone_e164,
             coalesce(f.email, u.email) as email, t.name as tenant_name
      from site_feedback f
      join users u on u.id = f.user_id
      left join tenants t on t.id = f.tenant_id
      where f.audience = ${view}
      ${page}
    `)) as unknown as Row[];
    const out = finish(rows, (r) => ({
      id: r['id'] as string,
      overallRating: Number(r['overall_rating']),
      discoveryRating: num(r['discovery_rating']),
      bookingRating: num(r['booking_rating']),
      eventCreationRating: num(r['event_creation_rating']),
      venueCreationRating: num(r['venue_creation_rating']),
      membershipCreationRating: num(r['membership_creation_rating']),
      challenges: (r['challenges'] as string | null) ?? null,
      comments: (r['comments'] as string | null) ?? null,
      source: r['source'] as string,
      createdAt: iso(r['created_at']),
      person: person(r),
      tenant: r['tenant_id']
        ? { id: r['tenant_id'] as string, name: r['tenant_name'] as string }
        : null,
    }));
    const [s] = (await db.execute(sql`
      select count(*) as count, avg(overall_rating) as overall,
             avg(discovery_rating) as discovery, avg(booking_rating) as booking,
             avg(event_creation_rating) as event_creation,
             avg(venue_creation_rating) as venue_creation,
             avg(membership_creation_rating) as membership_creation
      from site_feedback where audience = ${view}
    `)) as unknown as Row[];
    return {
      view,
      ...out,
      summary: {
        count: Number(s?.['count'] ?? 0),
        overall: avg(s?.['overall']),
        discovery: avg(s?.['discovery']),
        booking: avg(s?.['booking']),
        eventCreation: avg(s?.['event_creation']),
        venueCreation: avg(s?.['venue_creation']),
        membershipCreation: avg(s?.['membership_creation']),
      },
    };
  });
};
