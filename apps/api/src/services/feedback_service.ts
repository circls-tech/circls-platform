import { type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { isUniqueViolation } from '../db/errors.js';
import { feedbackDismissals, siteFeedback, userFeedback } from '../db/schema/user_feedback.js';
import type { User } from '../db/schema/users.js';
import { BadRequest, Conflict, Forbidden, NotFound } from '../lib/errors.js';
import type { TenantContext } from '../middleware/tenant_context.js';
import { myBookingsCondition } from './booking_ownership.js';

/**
 * Feedback prompts on the consumer site and the partner portal. The server
 * decides what (if anything) to ask; the client shows at most one prompt per
 * visit.
 *
 * Consumers, in this order:
 *  1. A 1–10 rating (+ optional note) of something they booked:
 *       - an event, once it has ended;
 *       - a court booking (venue visit), a day after check-in — or, when its
 *         QR ticket was never scanned (most venues don't use them), a day
 *         after the last slot ended;
 *       - a membership, a day after the first check-in — or, with no scan,
 *         a week after it started.
 *     Only the newest one due is asked about, once: after it is rated or
 *     dropped with "Not now", nothing older is asked (the next thing to fall
 *     due is), and nothing due more than RATING_WINDOW ago at all.
 *  2. The event-type poll — "What kind of event would you like to see next?"
 *     — once per person ("Not now" drops it too).
 *  3. The website survey, once their account is a day old. "Not now" brings it
 *     back a week later; once answered it is never asked again.
 *
 * Partners: the platform survey, once per organisation, asked of its Owners
 * and Managers (the people who create listings) once the org's first listing
 * is a day old, a week apart until someone on the team answers.
 *
 * Every answer snapshots the person's phone number and email so feedback
 * stays attached to them in the database.
 */

export const RATING_MIN = 1;
export const RATING_MAX = 10;
/** How long after check-in a venue visit or membership is rated. */
const CHECK_IN_DELAY = '1 day';
/** No check-in at all: how long after a membership starts it is rated — or
 *  CHECK_IN_DELAY after it ends, if that is sooner (a day pass). */
const MEMBERSHIP_NO_CHECK_IN_DELAY = '7 days';
/** Past this, a visit is too old to ask about. */
const RATING_WINDOW = '30 days';
/** The website surveys come back this long after each "Not now". */
export const NUDGE_EVERY = '7 days';
/** Which client sent an answer, as on login_events.source (+ the mobile apps). */
export const CONSUMER_SOURCES = ['consumer', 'consumer_app'] as const;
export const PARTNER_SOURCES = ['partners', 'partners_app'] as const;
/** Nobody is asked about the website on their first day. */
const SITE_SURVEY_AFTER = '1 day';

export interface EventTypeQuestion {
  key: string;
  question: string;
  options: string[];
  /** The option that asks them to type what they mean. */
  otherOption: string;
}

/**
 * The event-type poll, asked of every consumer once. The key is a stable id
 * stored alongside a text snapshot of the wording, so a reworded or new
 * question (a new key) never orphans old answers.
 */
export const EVENT_TYPE_QUESTION: EventTypeQuestion = {
  key: 'event_types_v2_next',
  question: 'What kind of event would you like to see next on Circls?',
  options: [
    'Sports & fitness',
    'Music & concerts',
    'Workshops & classes',
    'Comedy & theatre',
    'Food & social meetups',
    'Other',
  ],
  otherOption: 'Other',
};

export type RatingKind = 'event_feedback' | 'venue_feedback' | 'membership_feedback';

/** Prompt-key prefix per rating kind ("Not now" is stored under the key). */
const KEY_PREFIX: Record<RatingKind, string> = {
  event_feedback: 'event',
  venue_feedback: 'venue',
  membership_feedback: 'membership',
};

/** Something the consumer booked and can rate. */
export interface RatingSubject {
  /** Event id, court booking id, or user_memberships id. */
  id: string;
  /** Event name, venue name, or membership plan name. */
  name: string;
  /** The venue, when it isn't already the name. */
  place: string | null;
  orgName: string;
  /** When it happened: the event's start, the first slot, the membership start. */
  date: string | null;
}

export interface RatingPrompt {
  kind: RatingKind;
  key: string;
  subject: RatingSubject;
}

export interface EventTypePreferencePrompt {
  kind: 'event_type_preference';
  key: 'poll';
  question: EventTypeQuestion;
}

export interface SiteFeedbackPrompt {
  kind: 'site_feedback';
  key: 'site';
  /** Whether they have booked anything (else "Booking" starts on "Haven't tried"). */
  hasBooked: boolean;
}

export type FeedbackPrompt = RatingPrompt | EventTypePreferencePrompt | SiteFeedbackPrompt;

interface DueRow {
  kind: RatingKind;
  ref_id: string;
  due_at: string | Date;
  name: string;
  place: string | null;
  org_name: string;
  date: string | Date | null;
  booking_id: string | null;
  tenant_id: string;
  venue_id: string | null;
  membership_id: string | null;
}

/**
 * `<um>` (a user_memberships row) was really bought. A paid purchase inserts
 * its row as 'active' before the customer pays (see memberships_service), so a
 * row whose purchase booking never confirmed is an abandoned checkout. Rows
 * with no purchase booking — free sign-ups, members a partner added — count.
 * `um` and `tenant` are aliases from code, never input.
 */
function boughtMembershipSql(um: string, tenant: string) {
  return sql.raw(`not exists (
    select 1 from bookings mb
    where mb.tenant_id = ${tenant}
      and mb.item_type = 'membership'
      and mb.item_data->>'userMembershipId' = ${um}.id::text
      and mb.status not in ('confirmed', 'completed'))`);
}

/**
 * Everything `userId` could rate, with when it falls due: one row per event
 * (however many bookings they hold for it), per court booking and per
 * membership purchase. Bookings are theirs or shared with them (My bookings),
 * confirmed or completed — never cancelled or no-shows, never a walk-in staff
 * entered for someone else. Cancelled events, cancelled memberships and
 * abandoned membership checkouts drop out.
 *
 * With `recent` (picking the prompt), each branch also drops what can no
 * longer fall due inside RATING_WINDOW, so a regular's years of court bookings
 * aren't checked on every fetch: an event that ended before the window, a
 * court booking whose slots ended before it (a check-in can't come much
 * later), a membership that ended before it. Submitting a rating leaves it
 * off, so a slow answer still lands.
 */
function dueRatingsSql(userId: string, { recent }: { recent: boolean }) {
  const within = (cond: SQL) => (recent ? sql`and ${cond}` : sql``);
  return sql`
    with mine as materialized (
      select b.id, b.item_type, b.item_data, b.venue_id, b.tenant_id, b.time_range, b.created_at
      from bookings b
      where ${myBookingsCondition(userId, 'b')}
        and b.status in ('confirmed', 'completed')
    )
    select 'event_feedback' as kind, ev.id as ref_id,
           coalesce(ev.ends_at, ev.starts_at) as due_at,
           ev.name, v.name as place, t.name as org_name, ev.starts_at as date,
           (array_agg(b.id order by b.created_at desc))[1] as booking_id,
           ev.tenant_id, ev.venue_id, null::uuid as membership_id
    from mine b
    join events ev on ev.id = nullif(b.item_data->>'eventId', '')::uuid
    join tenants t on t.id = ev.tenant_id
    left join venues v on v.id = ev.venue_id
    where b.item_type = 'event' and ev.status <> 'cancelled'
      ${within(sql`coalesce(ev.ends_at, ev.starts_at) > now() - ${RATING_WINDOW}::interval`)}
    group by ev.id, v.name, t.name
    union all
    select 'venue_feedback', b.id,
           coalesce(scan.at, slot.ends_at) + ${CHECK_IN_DELAY}::interval,
           v.name, null, t.name, slot.starts_at,
           b.id, b.tenant_id, b.venue_id, null
    from mine b
    join venues v on v.id = b.venue_id
    join tenants t on t.id = b.tenant_id
    cross join lateral (
      select min(q.first_scanned_at) as at from qr_tickets q where q.booking_id = b.id
    ) scan
    cross join lateral (
      select coalesce(min(lower(s.time_range)), lower(b.time_range)) as starts_at,
             coalesce(max(upper(s.time_range)), upper(b.time_range)) as ends_at
      from slots s where s.booking_id = b.id
    ) slot
    where b.item_type = 'slot'
      ${within(sql`(upper(b.time_range) is null
           or upper(b.time_range) > now() - ${RATING_WINDOW}::interval - interval '2 days')`)}
    union all
    select 'membership_feedback', um.id,
           coalesce(scan.at + ${CHECK_IN_DELAY}::interval,
                    least(um.starts_at + ${MEMBERSHIP_NO_CHECK_IN_DELAY}::interval,
                          um.ends_at + ${CHECK_IN_DELAY}::interval)),
           m.name, v.name, t.name, um.starts_at,
           null, m.tenant_id, m.venue_id, m.id
    from user_memberships um
    join memberships m on m.id = um.membership_id
    join tenants t on t.id = m.tenant_id
    left join venues v on v.id = m.venue_id
    cross join lateral (
      select min(q.first_scanned_at) as at from qr_tickets q where q.user_membership_id = um.id
    ) scan
    where um.user_id = ${userId}::uuid and um.status in ('active', 'expired')
      ${within(sql`um.ends_at > now() - ${RATING_WINDOW}::interval - ${CHECK_IN_DELAY}::interval`)}
      and ${boughtMembershipSql('um', 'm.tenant_id')}
  `;
}

/** Postgres expression for a due row's prompt key ('event:<id>' etc.). */
const DUE_KEY_SQL = sql.raw(`(case d.kind when 'event_feedback' then 'event:'
  when 'venue_feedback' then 'venue:' else 'membership:' end) || d.ref_id::text`);

/** Whether `userId` already rated the due row `d`. */
const RATED_SQL = (userId: string) => sql`exists (
  select 1 from user_feedback f
  where f.user_id = ${userId}::uuid and f.kind = d.kind::user_feedback_kind
    and d.ref_id = case d.kind when 'event_feedback' then f.event_id
                               when 'venue_feedback' then f.booking_id
                               else f.user_membership_id end)`;

function iso(v: string | Date | null): string | null {
  return v == null ? null : new Date(v).toISOString();
}

function toRatingPrompt(row: DueRow): RatingPrompt {
  return {
    kind: row.kind,
    key: `${KEY_PREFIX[row.kind]}:${row.ref_id}`,
    subject: {
      id: row.ref_id,
      name: row.name,
      place: row.place ?? null,
      orgName: row.org_name,
      date: iso(row.date),
    },
  };
}

/**
 * The newest thing due for `userId` — only ever the newest. Once they have
 * rated or turned it down, nothing older is asked about (no working through a
 * backlog, and nothing from before launch beyond the latest), but whatever
 * falls due after it is.
 */
async function nextRatingPrompt(userId: string): Promise<RatingPrompt | null> {
  const rows = (await db.execute(sql`
    select d.*,
           ${RATED_SQL(userId)}
             or exists (select 1 from feedback_dismissals x
                        where x.user_id = ${userId}::uuid and x.prompt_key = ${DUE_KEY_SQL})
             as handled
    from (${dueRatingsSql(userId, { recent: true })}) d
    where d.due_at <= now()
      and d.due_at > now() - ${RATING_WINDOW}::interval
    order by d.due_at desc
    limit 1
  `)) as unknown as (DueRow & { handled: boolean })[];
  const newest = rows[0];
  return newest && !newest.handled ? toRatingPrompt(newest) : null;
}

/**
 * Decide which prompt (if any) to show this consumer: a rating due, else the
 * event-type poll, else the website survey; null when there is nothing to ask.
 */
export async function getFeedbackPrompt(user: Pick<User, 'id'>): Promise<FeedbackPrompt | null> {
  const rating = await nextRatingPrompt(user.id);
  if (rating) return rating;

  const [state] = (await db.execute(sql`
    select
      -- Went through, as elsewhere (confirmed, completed, no-show): an
      -- abandoned checkout's pending booking doesn't make them a booker.
      exists (select 1 from bookings b
              where ${myBookingsCondition(user.id, 'b')}
                and b.status in ('confirmed', 'completed', 'no_show'))
        or exists (select 1 from user_memberships um
                   join memberships m on m.id = um.membership_id
                   where um.user_id = ${user.id}::uuid
                     and ${boughtMembershipSql('um', 'm.tenant_id')})
        as has_booked,
      exists (select 1 from user_feedback f
              where f.user_id = ${user.id}::uuid and f.kind = 'event_type_preference')
        or exists (select 1 from feedback_dismissals x
                   where x.user_id = ${user.id}::uuid and x.prompt_key = 'poll')
        as poll_done,
      exists (select 1 from site_feedback s
              where s.user_id = ${user.id}::uuid and s.audience = 'consumer')
        as site_answered,
      exists (select 1 from feedback_dismissals x
              where x.user_id = ${user.id}::uuid and x.prompt_key = 'site'
                and x.dismissed_at > now() - ${NUDGE_EVERY}::interval)
        as site_snoozed,
      (select u.created_at < now() - ${SITE_SURVEY_AFTER}::interval
         from users u where u.id = ${user.id}::uuid)
        as site_due
  `)) as unknown as {
    has_booked: boolean;
    poll_done: boolean;
    site_answered: boolean;
    site_snoozed: boolean;
    site_due: boolean | null;
  }[];
  if (!state) return null;

  if (!state.poll_done) {
    return { kind: 'event_type_preference', key: 'poll', question: EVENT_TYPE_QUESTION };
  }

  if (!state.site_answered && !state.site_snoozed && state.site_due) {
    return { kind: 'site_feedback', key: 'site', hasBooked: state.has_booked };
  }
  return null;
}

export interface SubmittedFeedback {
  id: string;
  kind: RatingKind | 'event_type_preference' | 'site_feedback' | 'partner_site_feedback';
  createdAt: string;
}

function cleanText(v: string | null | undefined): string | null {
  const t = v?.trim();
  return t ? t : null;
}

/**
 * Record a 1–10 rating of something the consumer booked. It must be theirs and
 * already due (the same rules that raise the prompt, minus the 30-day cut-off,
 * so a slow answer still lands); the partial unique indexes, surfaced as a
 * friendly Conflict, keep it to one per event / court booking / membership.
 */
export async function submitRating(
  user: User,
  input: {
    kind: RatingKind;
    id: string;
    rating: number;
    comment?: string | undefined;
    source?: string | undefined;
  },
): Promise<SubmittedFeedback> {
  const rows = (await db.execute(sql`
    select d.* from (${dueRatingsSql(user.id, { recent: false })}) d
    where d.kind = ${input.kind} and d.ref_id = ${input.id}::uuid and d.due_at <= now()
    limit 1
  `)) as unknown as DueRow[];
  const due = rows[0];
  if (!due) {
    throw new NotFound('Nothing to rate here yet', 'feedback_not_eligible');
  }
  try {
    const [row] = await db
      .insert(userFeedback)
      .values({
        userId: user.id,
        phoneE164: user.phoneE164,
        email: user.email,
        kind: input.kind,
        tenantId: due.tenant_id,
        eventId: input.kind === 'event_feedback' ? due.ref_id : null,
        bookingId: due.booking_id,
        venueId: due.venue_id,
        membershipId: due.membership_id,
        userMembershipId: input.kind === 'membership_feedback' ? due.ref_id : null,
        rating: input.rating,
        comment: cleanText(input.comment),
        source: input.source ?? 'consumer',
      })
      .returning();
    if (!row) throw new Conflict('Feedback already submitted', 'feedback_exists');
    return { id: row.id, kind: input.kind, createdAt: row.createdAt.toISOString() };
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new Conflict('You have already rated this', 'feedback_exists');
    }
    throw err;
  }
}

/**
 * Record the consumer's answer to the event-type poll. The answer must be one
 * of the question's options; choosing "Other" needs the typed text, which is
 * kept in `comment` (so answers still group by option). One answer per user
 * (partial unique index → friendly Conflict).
 */
export async function submitEventTypePreference(
  user: User,
  input: {
    questionKey: string;
    answer: string;
    other?: string | undefined;
    source?: string | undefined;
  },
): Promise<SubmittedFeedback> {
  const question = EVENT_TYPE_QUESTION;
  if (input.questionKey !== question.key) {
    throw new BadRequest('Unknown question', 'feedback_unknown_question');
  }
  if (!question.options.includes(input.answer)) {
    throw new BadRequest('Answer must be one of the offered options', 'feedback_invalid_answer');
  }
  const other = input.answer === question.otherOption ? cleanText(input.other) : null;
  if (input.answer === question.otherOption && !other) {
    throw new BadRequest('Tell us what kind of event you mean', 'feedback_other_required');
  }
  try {
    const [row] = await db
      .insert(userFeedback)
      .values({
        userId: user.id,
        phoneE164: user.phoneE164,
        email: user.email,
        kind: 'event_type_preference',
        questionKey: question.key,
        question: question.question,
        answer: input.answer,
        comment: other,
        source: input.source ?? 'consumer',
      })
      .returning();
    if (!row) throw new Conflict('Preference already submitted', 'feedback_exists');
    return {
      id: row.id,
      kind: 'event_type_preference',
      createdAt: row.createdAt.toISOString(),
    };
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new Conflict('Preference already submitted', 'feedback_exists');
    }
    throw err;
  }
}

export interface ConsumerSiteFeedbackInput {
  overallRating: number;
  /** null = "Haven't tried yet". */
  discoveryRating?: number | null | undefined;
  bookingRating?: number | null | undefined;
  challenges?: string | undefined;
  comments?: string | undefined;
  source?: string | undefined;
}

/** Record the consumer website survey — once per person. */
export async function submitConsumerSiteFeedback(
  user: User,
  input: ConsumerSiteFeedbackInput,
): Promise<SubmittedFeedback> {
  try {
    const [row] = await db
      .insert(siteFeedback)
      .values({
        audience: 'consumer',
        userId: user.id,
        phoneE164: user.phoneE164,
        email: user.email,
        overallRating: input.overallRating,
        discoveryRating: input.discoveryRating ?? null,
        bookingRating: input.bookingRating ?? null,
        challenges: cleanText(input.challenges),
        comments: cleanText(input.comments),
        source: input.source ?? 'consumer',
      })
      .returning();
    if (!row) throw new Conflict('Feedback already submitted', 'feedback_exists');
    return { id: row.id, kind: 'site_feedback', createdAt: row.createdAt.toISOString() };
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new Conflict('Thanks — you have already sent us your feedback', 'feedback_exists');
    }
    throw err;
  }
}

/** Prompt keys a consumer may dismiss. */
const CONSUMER_KEY = /^(?:(?:event|venue|membership):[0-9a-f-]{36}|poll|site)$/;

async function recordDismissal(userId: string, promptKey: string): Promise<void> {
  await db
    .insert(feedbackDismissals)
    .values({ userId, promptKey })
    .onConflictDoUpdate({
      target: [feedbackDismissals.userId, feedbackDismissals.promptKey],
      set: { dismissedAt: sql`now()`, times: sql`${feedbackDismissals.times} + 1` },
    });
}

/**
 * "Not now" on a consumer prompt: a rating or the poll is dropped for good,
 * the website survey is snoozed for NUDGE_EVERY.
 */
export async function dismissConsumerPrompt(userId: string, promptKey: string): Promise<void> {
  if (!CONSUMER_KEY.test(promptKey)) {
    throw new BadRequest('Unknown prompt', 'feedback_unknown_prompt');
  }
  await recordDismissal(userId, promptKey);
}

// ── Partner portal ────────────────────────────────────────────────────────────

/** Owners and Managers create listings, so they are the ones asked. A Circls
 *  super admin visiting the org never answers for it. */
function canAnswerForOrg(ctx: TenantContext): boolean {
  return (
    !ctx.isPlatform && !ctx.superAdmin && (ctx.role === 'owner' || ctx.role === 'manager')
  );
}

export interface PartnerSiteFeedbackPrompt {
  kind: 'partner_site_feedback';
  key: string;
  /** Which listing types the org has created; the rest start on "Haven't tried". */
  tried: { events: boolean; venues: boolean; memberships: boolean };
}

/**
 * The platform survey for this org, or null: the org hasn't answered, its first
 * listing is at least a day old, and this person hasn't said "Not now" in the
 * last week.
 */
export async function getPartnerFeedbackPrompt(
  userId: string,
  ctx: TenantContext,
): Promise<PartnerSiteFeedbackPrompt | null> {
  if (!canAnswerForOrg(ctx)) return null;
  const key = `partner:${ctx.tenantId}`;
  const [row] = (await db.execute(sql`
    with firsts as (
      select
        (select min(created_at) from events where tenant_id = ${ctx.tenantId}::uuid) as event_at,
        (select min(created_at) from venues where tenant_id = ${ctx.tenantId}::uuid) as venue_at,
        (select min(created_at) from memberships where tenant_id = ${ctx.tenantId}::uuid) as membership_at
    )
    select
      f.event_at is not null as events,
      f.venue_at is not null as venues,
      f.membership_at is not null as memberships,
      coalesce(least(f.event_at, f.venue_at, f.membership_at) < now() - ${SITE_SURVEY_AFTER}::interval, false)
        as due,
      exists (select 1 from site_feedback s
              where s.audience = 'partner' and s.tenant_id = ${ctx.tenantId}::uuid) as answered,
      exists (select 1 from feedback_dismissals x
              where x.user_id = ${userId}::uuid and x.prompt_key = ${key}
                and x.dismissed_at > now() - ${NUDGE_EVERY}::interval) as snoozed
    from firsts f
  `)) as unknown as {
    events: boolean;
    venues: boolean;
    memberships: boolean;
    due: boolean;
    answered: boolean;
    snoozed: boolean;
  }[];
  if (!row || !row.due || row.answered || row.snoozed) return null;
  return {
    kind: 'partner_site_feedback',
    key,
    tried: { events: row.events, venues: row.venues, memberships: row.memberships },
  };
}

export interface PartnerSiteFeedbackInput {
  overallRating: number;
  /** null = "Haven't tried yet". */
  eventCreationRating?: number | null | undefined;
  venueCreationRating?: number | null | undefined;
  membershipCreationRating?: number | null | undefined;
  challenges?: string | undefined;
  comments?: string | undefined;
  source?: string | undefined;
}

/** Record the platform survey for the org — once per organisation. */
export async function submitPartnerSiteFeedback(
  user: User,
  ctx: TenantContext,
  input: PartnerSiteFeedbackInput,
): Promise<SubmittedFeedback> {
  if (!canAnswerForOrg(ctx)) {
    throw new Forbidden('Only Owners and Managers can answer for the organisation', 'forbidden');
  }
  try {
    const [row] = await db
      .insert(siteFeedback)
      .values({
        audience: 'partner',
        userId: user.id,
        tenantId: ctx.tenantId,
        phoneE164: user.phoneE164,
        email: user.email,
        overallRating: input.overallRating,
        eventCreationRating: input.eventCreationRating ?? null,
        venueCreationRating: input.venueCreationRating ?? null,
        membershipCreationRating: input.membershipCreationRating ?? null,
        challenges: cleanText(input.challenges),
        comments: cleanText(input.comments),
        source: input.source ?? 'partners',
      })
      .returning();
    if (!row) throw new Conflict('Feedback already submitted', 'feedback_exists');
    return { id: row.id, kind: 'partner_site_feedback', createdAt: row.createdAt.toISOString() };
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new Conflict('Someone on your team has already sent us feedback', 'feedback_exists');
    }
    throw err;
  }
}

/** "Not now" on the partner survey: snoozed for this person for NUDGE_EVERY. */
export async function dismissPartnerPrompt(userId: string, ctx: TenantContext): Promise<void> {
  await recordDismissal(userId, `partner:${ctx.tenantId}`);
}
