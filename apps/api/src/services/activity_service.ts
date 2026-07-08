import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

/**
 * Tenant activity read models (partner portal "Activity" page).
 *
 * The feed unifies everything a partner thinks of as "something happened":
 * slot bookings, event registrations and membership purchases. Almost all of
 * those live in the `bookings` ledger (item_type discriminates), with ONE
 * exception: a free membership purchase without a coupon creates only a
 * `user_memberships` row (memberships_service skips the synthetic booking), so
 * the feed UNIONs those in — paid/couponed purchases are excluded from the
 * union via the `userMembershipId` stamped into the booking's item_data.
 *
 * Raw `db.execute` is used (mirroring bookings_read_service) so tstzrange
 * bounds and item_data joins happen in SQL; keyset pagination over
 * (created_at, id) DESC mirrors audit_log_service.
 */

export type ActivityItemType = 'slot' | 'event' | 'membership';

export interface ActivityItem {
  id: string;
  itemType: ActivityItemType;
  status: string;
  channel: string;
  customerName: string | null;
  customerContact: string | null;
  totalPaise: number | null;
  createdAt: string;
  venueId: string | null;
  venueName: string | null;
  /** Arena label for slot bookings, event name, or membership plan name. */
  itemName: string | null;
  /** Membership tier, when the purchase carries one. */
  tierName: string | null;
  /** Session start/end (slots/events) or membership validity window. */
  startAt: string | null;
  endAt: string | null;
}

export interface ActivityPage {
  rows: ActivityItem[];
  nextCursor: string | null;
}

export interface ActivityFeedParams {
  type?: ActivityItemType;
  venueId?: string;
  from?: string; // ISO datetime, inclusive (created_at)
  to?: string; // ISO datetime, exclusive (created_at)
  q?: string; // customer name/contact search
  /** Filter to sessions/windows STARTING on this calendar day ('YYYY-MM-DD' in `tz`) — the calendar's click-through. */
  sessionDate?: string;
  /** IANA tz `sessionDate` is interpreted in. */
  tz?: string;
  cursor?: string; // opaque: `${createdAtIso}|${id}`
  limit?: number; // default 50, max 100
}

function encodeCursor(createdAt: string, id: string): string {
  return `${createdAt}|${id}`;
}

function decodeCursor(cursor: string): { ts: string; id: string } | null {
  const idx = cursor.lastIndexOf('|');
  if (idx === -1) return null;
  const ts = cursor.slice(0, idx);
  const id = cursor.slice(idx + 1);
  if (!ts || !id) return null;
  return { ts, id };
}

export async function listActivity(
  tenantId: string,
  params: ActivityFeedParams = {},
): Promise<ActivityPage> {
  const limit = Math.min(params.limit ?? 50, 100);
  const fetchLimit = limit + 1; // one extra row detects a next page

  const conditions: ReturnType<typeof sql>[] = [sql`true`];
  if (params.type) conditions.push(sql`f.item_type = ${params.type}`);
  if (params.venueId) conditions.push(sql`f.venue_id = ${params.venueId}::uuid`);
  if (params.from) {
    conditions.push(sql`f.created_at >= ${new Date(params.from).toISOString()}::timestamptz`);
  }
  if (params.to) {
    conditions.push(sql`f.created_at < ${new Date(params.to).toISOString()}::timestamptz`);
  }
  if (params.q) {
    const like = '%' + params.q + '%';
    conditions.push(sql`(f.customer_name ilike ${like} or f.customer_contact ilike ${like})`);
  }
  if (params.sessionDate) {
    const tz = params.tz ?? 'Asia/Kolkata';
    // Sessions only (slot/event) — the calendar this click-through comes from
    // does not count membership validity windows.
    conditions.push(
      sql`f.item_type in ('slot', 'event') and f.start_at is not null
          and (f.start_at at time zone ${tz})::date = ${params.sessionDate}::date`,
    );
  }
  if (params.cursor) {
    const decoded = decodeCursor(params.cursor);
    if (decoded) {
      conditions.push(
        sql`(f.created_at, f.id) < (${decoded.ts}::timestamptz, ${decoded.id}::uuid)`,
      );
    }
  }
  const whereClause = conditions.reduce((acc, cond) => sql`${acc} and ${cond}`);

  const raw = await db.execute<Record<string, unknown>>(sql`
    with booking_feed as (
      select
        b.id                                                     as id,
        b.item_type::text                                        as item_type,
        b.status::text                                           as status,
        b.channel::text                                          as channel,
        coalesce(b.customer_name, u.display_name)                as customer_name,
        coalesce(b.customer_contact, u.phone_e164, u.email)      as customer_contact,
        b.total_paise                                            as total_paise,
        b.created_at                                             as created_at,
        b.venue_id                                               as venue_id,
        v.name                                                   as venue_name,
        case b.item_type::text
          when 'slot'       then coalesce(sa.arena_label, ab.name)
          when 'event'      then e.name
          when 'membership' then m.name
        end                                                      as item_name,
        mt.name                                                  as tier_name,
        case b.item_type::text
          when 'event'      then e.starts_at
          when 'membership' then um.starts_at
          else coalesce(sa.first_start, lower(b.time_range))
        end                                                      as start_at,
        case b.item_type::text
          when 'event'      then e.ends_at
          when 'membership' then um.ends_at
          else coalesce(sa.last_end, upper(b.time_range))
        end                                                      as end_at
      from bookings b
      left join users u   on u.id = b.customer_user_id
      left join venues v  on v.id = b.venue_id
      left join arenas ab on ab.id = b.slot_arena_id
      left join events e  on b.item_type = 'event'
                         and e.id = nullif(b.item_data->>'eventId', '')::uuid
      left join memberships m on b.item_type = 'membership'
                             and m.id = nullif(b.item_data->>'membershipId', '')::uuid
      left join user_memberships um on b.item_type = 'membership'
                                   and um.id = nullif(b.item_data->>'userMembershipId', '')::uuid
      left join membership_tiers mt on mt.id = um.membership_tier_id
      left join lateral (
        select case when count(distinct s.arena_id) > 1 then 'Multiple courts'
                    else min(a.name) end          as arena_label,
               min(lower(s.time_range))           as first_start,
               max(upper(s.time_range))           as last_end
        from slots s
        join arenas a on a.id = s.arena_id
        where s.booking_id = b.id and s.deleted_at is null
      ) sa on true
      where b.tenant_id = ${tenantId}
    ),
    free_membership_feed as (
      -- Free, coupon-less membership purchases have no bookings row.
      select
        um.id                                       as id,
        'membership'                                as item_type,
        'confirmed'                                 as status,
        'circls'                                    as channel,
        u.display_name                              as customer_name,
        coalesce(u.phone_e164, u.email)             as customer_contact,
        0::bigint                                   as total_paise,
        um.created_at                               as created_at,
        m.venue_id                                  as venue_id,
        v.name                                      as venue_name,
        m.name                                      as item_name,
        mt.name                                     as tier_name,
        um.starts_at                                as start_at,
        um.ends_at                                  as end_at
      from user_memberships um
      join memberships m on m.id = um.membership_id
      join users u       on u.id = um.user_id
      left join venues v on v.id = m.venue_id
      left join membership_tiers mt on mt.id = um.membership_tier_id
      where m.tenant_id = ${tenantId}
        and not exists (
          select 1 from bookings b2
          where b2.tenant_id = ${tenantId}
            and b2.item_type = 'membership'
            and b2.item_data->>'userMembershipId' = um.id::text
        )
    )
    select * from (
      select * from booking_feed
      union all
      select * from free_membership_feed
    ) f
    where ${whereClause}
    order by f.created_at desc, f.id desc
    limit ${fetchLimit}
  `);

  const rows = raw as unknown as Record<string, unknown>[];
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  const items: ActivityItem[] = pageRows.map((r) => ({
    id: r['id'] as string,
    itemType: r['item_type'] as ActivityItemType,
    status: r['status'] as string,
    channel: r['channel'] as string,
    customerName: (r['customer_name'] as string | null) ?? null,
    customerContact: (r['customer_contact'] as string | null) ?? null,
    totalPaise: r['total_paise'] == null ? null : Number(r['total_paise']),
    createdAt: new Date(r['created_at'] as string).toISOString(),
    venueId: (r['venue_id'] as string | null) ?? null,
    venueName: (r['venue_name'] as string | null) ?? null,
    itemName: (r['item_name'] as string | null) ?? null,
    tierName: (r['tier_name'] as string | null) ?? null,
    startAt: r['start_at'] == null ? null : new Date(r['start_at'] as string).toISOString(),
    endAt: r['end_at'] == null ? null : new Date(r['end_at'] as string).toISOString(),
  }));

  const last = items[items.length - 1];
  return {
    rows: items,
    nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}

export interface ActivityDailyCount {
  date: string; // 'YYYY-MM-DD' in the requested tz
  bookings: number;
}

export interface ActivityDailyParams {
  /** Calendar month, 'YYYY-MM'. */
  month: string;
  /** IANA timezone the days are bucketed in. */
  tz: string;
  venueId?: string;
}

/**
 * Per-day count of session-bearing bookings (slots + events) for one calendar
 * month — the Activity page's calendar. A booking counts on the day its
 * session STARTS (slot time_range / event starts_at) in the given tz;
 * memberships have no session and are excluded. Cancelled/no-show bookings do
 * not count. Days with zero bookings are omitted (the client fills the grid).
 */
export async function getActivityDailyCounts(
  tenantId: string,
  params: ActivityDailyParams,
): Promise<ActivityDailyCount[]> {
  const monthStart = `${params.month}-01`;
  const venueClause = params.venueId ? sql` and b.venue_id = ${params.venueId}::uuid` : sql``;

  const raw = await db.execute<Record<string, unknown>>(sql`
    with sessions as (
      select (coalesce(
                lower(b.time_range),
                e.starts_at,
                b.created_at
              ) at time zone ${params.tz})::date as day
      from bookings b
      left join events e on b.item_type = 'event'
                        and e.id = nullif(b.item_data->>'eventId', '')::uuid
      where b.tenant_id = ${tenantId}
        and b.item_type in ('slot', 'event')
        and b.status in ('pending', 'confirmed', 'completed')${venueClause}
    )
    select to_char(day, 'YYYY-MM-DD') as date, count(*)::int as bookings
    from sessions
    where day >= ${monthStart}::date
      and day < (${monthStart}::date + interval '1 month')
    group by day
    order by day
  `);

  return (raw as unknown as Record<string, unknown>[]).map((r) => ({
    date: r['date'] as string,
    bookings: Number(r['bookings']),
  }));
}

export interface MembershipWindowItem {
  userMembershipId: string;
  buyerName: string | null;
  buyerContact: string | null;
  membershipName: string;
  tierName: string | null;
  status: string;
  startsAt: string;
  endsAt: string;
}

export interface MembershipWindows {
  /** Started in the last 7 days or starting within `withinDays`. */
  starting: MembershipWindowItem[];
  /** Ended in the last 7 days or ending within `withinDays`. */
  ending: MembershipWindowItem[];
}

const MEMBERSHIP_WINDOW_LIMIT = 100;

/**
 * Memberships whose validity window opens or closes around now — the Activity
 * page's "starting & ending soon" panel. Cancelled purchases are excluded.
 */
export async function listMembershipWindows(
  tenantId: string,
  withinDays: number,
): Promise<MembershipWindows> {
  const windowQuery = (col: 'starts_at' | 'ends_at') => sql`
    select um.id, um.status, um.starts_at, um.ends_at,
           u.display_name, u.phone_e164, u.email,
           m.name as membership_name, mt.name as tier_name
    from user_memberships um
    join memberships m on m.id = um.membership_id
    join users u       on u.id = um.user_id
    left join membership_tiers mt on mt.id = um.membership_tier_id
    where m.tenant_id = ${tenantId}
      and um.status <> 'cancelled'
      and um.${sql.raw(col)} >= now() - interval '7 days'
      and um.${sql.raw(col)} <= now() + make_interval(days => ${withinDays})
    order by um.${sql.raw(col)} asc
    limit ${MEMBERSHIP_WINDOW_LIMIT}
  `;

  const toItems = (raw: unknown): MembershipWindowItem[] =>
    (raw as Record<string, unknown>[]).map((r) => ({
      userMembershipId: r['id'] as string,
      buyerName: (r['display_name'] as string | null) ?? null,
      buyerContact: ((r['phone_e164'] as string | null) ?? (r['email'] as string | null)) ?? null,
      membershipName: r['membership_name'] as string,
      tierName: (r['tier_name'] as string | null) ?? null,
      status: r['status'] as string,
      startsAt: new Date(r['starts_at'] as string).toISOString(),
      endsAt: new Date(r['ends_at'] as string).toISOString(),
    }));

  const [starting, ending] = await Promise.all([
    db.execute<Record<string, unknown>>(windowQuery('starts_at')),
    db.execute<Record<string, unknown>>(windowQuery('ends_at')),
  ]);

  return { starting: toItems(starting), ending: toItems(ending) };
}
