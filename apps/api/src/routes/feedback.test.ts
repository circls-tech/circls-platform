import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Feedback prompts: 1–10 ratings of events (once ended), venue visits and
// memberships (a day after check-in, or the no-scan fallbacks), the event-type
// poll for consumers with no bookings, the weekly website surveys for
// consumers and partner orgs, and the admin report.
// Integration (RUN_INTEGRATION + a real Postgres).
//
// RUN makes every identity unique per run so re-runs against the persistent
// sandbox DB never trip the one-per-user unique indexes.
const RUN = vi.hoisted(() => Date.now());
vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const tail = String(RUN).slice(-8);
    const map: Record<string, Record<string, unknown>> = {
      // Phone-auth consumer with bookings and a membership.
      attendee: { uid: `fbuid_attendee_fb_${RUN}`, phone_number: `+9188${tail}` },
      // Phone-auth consumer with no bookings at all (one abandoned checkout).
      newbie: { uid: `fbuid_newbie_fb_${RUN}`, phone_number: `+9199${tail}` },
      // Phone-auth consumer whose only purchase is a day pass that has ended.
      pass: { uid: `fbuid_pass_fb_${RUN}`, phone_number: `+9177${tail}` },
      // Partner org team + a Circls admin.
      owner: { uid: `fbuid_owner_fb_${RUN}`, email: `owner_fb_${RUN}@x.com`, email_verified: true },
      manager: { uid: `fbuid_mgr_fb_${RUN}`, email: `mgr_fb_${RUN}@x.com`, email_verified: true },
      staff: { uid: `fbuid_staff_fb_${RUN}`, email: `staff_fb_${RUN}@x.com`, email_verified: true },
      padmin: { uid: `fbuid_padmin_fb_${RUN}`, email: `padmin_fb_${RUN}@x.com`, email_verified: true },
      pstaff: { uid: `fbuid_pstaff_fb_${RUN}`, email: `pstaff_fb_${RUN}@x.com`, email_verified: true },
    };
    const u = map[token];
    if (!u) throw new Error('bad token');
    return u;
  }),
  deleteFirebaseUser: vi.fn(async () => {}),
}));

const { closeDb, db } = await import('../db/client.js');
const { buildServer } = await import('../server.js');
const { EVENT_TYPE_QUESTION } = await import('../services/feedback_service.js');
const { __resetPlatformTenantCacheForTesting } = await import('../lib/authz/platform_tenant.js');

const runIntegration = Boolean(process.env.RUN_INTEGRATION);
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

function firstRow<T>(res: unknown): T {
  return (res as unknown as T[])[0]!;
}

describe.skipIf(!runIntegration)('feedback prompts', () => {
  let app: FastifyInstance;
  let attendeeId: string;
  let attendeePhone: string;
  let newbieId: string;
  let passId: string;
  let passMembershipId: string;
  let abandonedMembershipId: string;
  let tenantId: string;
  let venueId: string;
  let pastEventId: string;
  let oldEventId: string;
  let upcomingEventId: string;
  let unscannedSlotId: string;
  let freshScanSlotId: string;
  let userMembershipId: string;
  let partnerTenantId: string;
  let freshTenantId: string;
  const PLATFORM_SLUG = `circls-internal-test-fb-${RUN}`;
  let prevSlug: string | undefined;

  const get = (token: string, url = '/v1/consumer/feedback/prompt') =>
    app.inject({ method: 'GET', url, headers: bearer(token) });
  const post = (token: string, payload: Record<string, unknown>, url = '/v1/consumer/feedback') =>
    app.inject({ method: 'POST', url, headers: bearer(token), payload });
  const prompt = async (token: string) => (await get(token)).json().prompt;

  const insertEvent = async (name: string, endedAgo: string) =>
    firstRow<{ id: string }>(
      await db.execute(sql`
        INSERT INTO events (tenant_id, venue_id, name, status, starts_at, ends_at)
        VALUES (${tenantId}::uuid, ${venueId}::uuid, ${name}, 'published',
                now() - ${endedAgo}::interval - interval '2 hours', now() - ${endedAgo}::interval)
        RETURNING id`),
    ).id;

  const insertBooking = async (
    itemType: 'event' | 'slot',
    opts: { eventId?: string; endedAgo?: string; status?: string },
  ) =>
    firstRow<{ id: string }>(
      await db.execute(sql`
        INSERT INTO bookings (tenant_id, venue_id, item_type, channel, payment_method, status,
                              item_data, time_range, customer_user_id, total_paise)
        VALUES (${tenantId}::uuid, ${venueId}::uuid, ${itemType}::booking_item_type, 'circls', 'free',
                ${opts.status ?? 'confirmed'}::booking_status,
                ${opts.eventId ? sql`jsonb_build_object('eventId', ${opts.eventId}::text)` : sql`'{}'::jsonb`},
                ${opts.endedAgo
                  ? sql`tstzrange(now() - ${opts.endedAgo}::interval - interval '1 hour', now() - ${opts.endedAgo}::interval)`
                  : sql`null`},
                ${attendeeId}::uuid, 0)
        RETURNING id`),
    ).id;

  beforeAll(async () => {
    prevSlug = process.env['CIRCLS_INTERNAL_TENANT_SLUG'];
    process.env['CIRCLS_INTERNAL_TENANT_SLUG'] = PLATFORM_SLUG;
    __resetPlatformTenantCacheForTesting();

    app = await buildServer();
    await app.ready();

    const me = await get('attendee', '/v1/consumer/me');
    expect(me.statusCode).toBe(200);
    const profile = (me.json() as { profile: { id: string; phoneE164: string } }).profile;
    attendeeId = profile.id;
    attendeePhone = profile.phoneE164;
    newbieId = (await get('newbie', '/v1/consumer/me')).json().profile.id;

    tenantId = firstRow<{ id: string }>(
      await db.execute(sql`
        INSERT INTO tenants (name, slug, status, subscription_status)
        VALUES (${'FB Org ' + RUN}, ${'fb-org-' + RUN}, 'active', 'trial')
        RETURNING id`),
    ).id;
    venueId = firstRow<{ id: string }>(
      await db.execute(sql`
        INSERT INTO venues (tenant_id, name, status) VALUES (${tenantId}::uuid, 'FB Venue', 'active')
        RETURNING id`),
    ).id;

    // Due newest-first: the event (ended a day ago), then the unscanned court
    // booking (slot ended 3 days ago → due 2 days ago), then the membership
    // (started 10 days ago, never scanned → due 3 days ago). Only the newest
    // is asked; the tests later move the other two forward in time.
    pastEventId = await insertEvent('FB Past Cup', '1 day');
    // Ended 40 days ago: past the 30-day window, never asked about.
    oldEventId = await insertEvent('FB Old Cup', '40 days');
    upcomingEventId = await insertEvent('FB Future Cup', '-7 days');
    const cancelledEventId = await insertEvent('FB Cancelled Booking Cup', '2 hours');
    for (const eventId of [pastEventId, oldEventId, upcomingEventId]) {
      await insertBooking('event', { eventId });
    }
    await insertBooking('event', { eventId: cancelledEventId, status: 'cancelled' });

    unscannedSlotId = await insertBooking('slot', { endedAgo: '3 days' });
    // Checked in two hours ago: not due until tomorrow.
    freshScanSlotId = await insertBooking('slot', { endedAgo: '1 hour' });
    await db.execute(sql`
      INSERT INTO qr_tickets (tenant_id, booking_id, item_type, code, scan_count, first_scanned_at, last_scanned_at, status)
      VALUES (${tenantId}::uuid, ${freshScanSlotId}::uuid, 'slot', ${'fb-qr-' + RUN}, 1,
              now() - interval '2 hours', now() - interval '2 hours', 'used')
    `);

    const membershipId = firstRow<{ id: string }>(
      await db.execute(sql`
        INSERT INTO memberships (tenant_id, venue_id, name, duration_days, status)
        VALUES (${tenantId}::uuid, ${venueId}::uuid, 'FB Gold', 30, 'active')
        RETURNING id`),
    ).id;
    userMembershipId = firstRow<{ id: string }>(
      await db.execute(sql`
        INSERT INTO user_memberships (user_id, membership_id, starts_at, ends_at, status)
        VALUES (${attendeeId}::uuid, ${membershipId}::uuid, now() - interval '10 days',
                now() + interval '20 days', 'active')
        RETURNING id`),
    ).id;

    // Abandoned paid checkouts: the user_memberships row is 'active' from the
    // start, but its purchase booking never left 'pending'. The attendee's would
    // be due six hours ago (newer than the event) if it counted; the newbie's
    // would make them "have booked".
    const abandon = async (userId: string, startedAgo: string) => {
      const um = firstRow<{ id: string }>(
        await db.execute(sql`
          INSERT INTO user_memberships (user_id, membership_id, starts_at, ends_at, status)
          VALUES (${userId}::uuid, ${membershipId}::uuid, now() - ${startedAgo}::interval,
                  now() + interval '20 days', 'active')
          RETURNING id`),
      ).id;
      await db.execute(sql`
        INSERT INTO bookings (tenant_id, venue_id, item_type, channel, payment_method, status,
                              item_data, customer_user_id, total_paise)
        VALUES (${tenantId}::uuid, ${venueId}::uuid, 'membership', 'circls', 'razorpay_route', 'pending',
                jsonb_build_object('membershipId', ${membershipId}::text, 'userMembershipId', ${um}::text),
                ${userId}::uuid, 99900)`);
      return um;
    };
    abandonedMembershipId = await abandon(attendeeId, '7 days 6 hours');
    await abandon(newbieId, '1 day');

    // A one-day pass that ended two days ago, never scanned: rated the day
    // after it ended, not a week after it started.
    passId = (await get('pass', '/v1/consumer/me')).json().profile.id;
    const dayPassId = firstRow<{ id: string }>(
      await db.execute(sql`
        INSERT INTO memberships (tenant_id, venue_id, name, duration_days, status)
        VALUES (${tenantId}::uuid, ${venueId}::uuid, 'FB Day Pass', 1, 'active')
        RETURNING id`),
    ).id;
    passMembershipId = firstRow<{ id: string }>(
      await db.execute(sql`
        INSERT INTO user_memberships (user_id, membership_id, starts_at, ends_at, status)
        VALUES (${passId}::uuid, ${dayPassId}::uuid, now() - interval '3 days',
                now() - interval '2 days', 'expired')
        RETURNING id`),
    ).id;

    // Partner org: Owner via the API, a Manager and Staff added directly; its
    // first listing (a venue) is two days old. A second org's venue is new.
    const created = await post('owner', {
      name: `FB Partner ${RUN}`,
      slug: `fb-partner-${RUN}`,
      country: 'India',
      acceptTerms: true,
    }, '/v1/tenants');
    expect(created.statusCode).toBe(200);
    partnerTenantId = created.json().id;
    const managerId = (await get('manager', '/v1/me')).json().id;
    const staffId = (await get('staff', '/v1/me')).json().id;
    await db.execute(sql`
      INSERT INTO tenant_members (tenant_id, user_id, role)
      VALUES (${partnerTenantId}::uuid, ${managerId}::uuid, 'manager'),
             (${partnerTenantId}::uuid, ${staffId}::uuid, 'staff')
    `);
    await db.execute(sql`
      INSERT INTO venues (tenant_id, name, status, created_at)
      VALUES (${partnerTenantId}::uuid, 'FB Partner Venue', 'active', now() - interval '2 days')
    `);
    const fresh = await post('owner', {
      name: `FB Fresh ${RUN}`,
      slug: `fb-fresh-${RUN}`,
      country: 'India',
      acceptTerms: true,
    }, '/v1/tenants');
    freshTenantId = fresh.json().id;
    await db.execute(sql`
      INSERT INTO venues (tenant_id, name, status) VALUES (${freshTenantId}::uuid, 'FB Fresh Venue', 'active')
    `);

    // Circls platform org: a Manager (admin.users.read) and Staff (not).
    const platformId = firstRow<{ id: string }>(
      await db.execute(sql`
        INSERT INTO tenants (name, slug, is_platform, status, subscription_status)
        VALUES ('Circls', ${PLATFORM_SLUG}, TRUE, 'active', 'trial')
        RETURNING id`),
    ).id;
    const padminId = (await get('padmin', '/v1/me')).json().id;
    const pstaffId = (await get('pstaff', '/v1/me')).json().id;
    await db.execute(sql`
      INSERT INTO tenant_members (tenant_id, user_id, role)
      VALUES (${platformId}::uuid, ${padminId}::uuid, 'manager'),
             (${platformId}::uuid, ${pstaffId}::uuid, 'staff')
    `);
  });

  afterAll(async () => {
    if (prevSlug === undefined) delete process.env['CIRCLS_INTERNAL_TENANT_SLUG'];
    else process.env['CIRCLS_INTERNAL_TENANT_SLUG'] = prevSlug;
    __resetPlatformTenantCacheForTesting();
    await app.close();
    await closeDb();
  });

  it('GET prompt without a token is 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/consumer/feedback/prompt' });
    expect(res.statusCode).toBe(401);
  });

  it('asks about the most recently ended event first', async () => {
    const p = await prompt('attendee');
    expect(p).toMatchObject({
      kind: 'event_feedback',
      key: `event:${pastEventId}`,
      subject: { id: pastEventId, name: 'FB Past Cup', place: 'FB Venue', orgName: `FB Org ${RUN}` },
    });
  });

  it('refuses ratings for things not yet due', async () => {
    const upcoming = await post('attendee', { kind: 'event_feedback', id: upcomingEventId, rating: 7 });
    expect(upcoming.statusCode).toBe(404);
    expect(upcoming.json().error.code).toBe('feedback_not_eligible');
    // Checked in two hours ago: rated from tomorrow, not today.
    const scanned = await post('attendee', { kind: 'venue_feedback', id: freshScanSlotId, rating: 7 });
    expect(scanned.statusCode).toBe(404);
  });

  it('never counts an abandoned membership checkout', async () => {
    // Its purchase booking is still pending: nothing to rate.
    const res = await post('attendee', { kind: 'membership_feedback', id: abandonedMembershipId, rating: 7 });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('feedback_not_eligible');
  });

  it('only takes a known client as the source', async () => {
    const res = await post('attendee', { kind: 'event_feedback', id: pastEventId, rating: 7, source: 'web' });
    expect(res.statusCode).toBe(400);
  });

  it('only takes whole ratings from 1 to 10', async () => {
    for (const rating of [0, 11, 7.5]) {
      const res = await post('attendee', { kind: 'event_feedback', id: pastEventId, rating });
      expect(res.statusCode).toBe(400);
    }
  });

  it('stores the event rating with the phone snapshot, once', async () => {
    const res = await post('attendee', {
      kind: 'event_feedback',
      id: pastEventId,
      rating: 9,
      comment: '  Great vibe  ',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().feedback.kind).toBe('event_feedback');

    const row = firstRow<Record<string, unknown>>(
      await db.execute(sql`
        select phone_e164, rating, comment, booking_id, tenant_id, venue_id from user_feedback
        where user_id = ${attendeeId}::uuid and kind = 'event_feedback' and event_id = ${pastEventId}::uuid`),
    );
    expect(row).toMatchObject({
      phone_e164: attendeePhone,
      rating: 9,
      comment: 'Great vibe',
      tenant_id: tenantId,
      venue_id: venueId,
    });
    expect(row['booking_id']).not.toBeNull();

    const dup = await post('attendee', { kind: 'event_feedback', id: pastEventId, rating: 1 });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('feedback_exists');
  });

  it('then skips the older court booking and membership: only the newest is asked', async () => {
    expect((await prompt('attendee'))?.kind).toBe('event_type_preference');
  });

  it('asks about a venue visit with no check-in that fell due since, a day after the slot ended', async () => {
    // The court booking now ended 36 hours ago: due 12 hours ago, newer than the event.
    await db.execute(sql`
      update bookings set time_range = tstzrange(now() - interval '37 hours', now() - interval '36 hours')
      where id = ${unscannedSlotId}::uuid`);
    const p = await prompt('attendee');
    expect(p).toMatchObject({
      kind: 'venue_feedback',
      key: `venue:${unscannedSlotId}`,
      subject: { id: unscannedSlotId, name: 'FB Venue', place: null },
    });
  });

  it('"Not now" on a rating drops it for good, and nothing older comes back', async () => {
    const res = await post('attendee', { key: `venue:${unscannedSlotId}` }, '/v1/consumer/feedback/dismiss');
    expect(res.statusCode).toBe(200);
    // The membership (due three days ago) is older still: skipped too.
    expect((await prompt('attendee'))?.kind).toBe('event_type_preference');
  });

  it('asks about a membership with no check-in a week after it started', async () => {
    await db.execute(sql`
      update user_memberships set starts_at = now() - interval '7 days 1 hour'
      where id = ${userMembershipId}::uuid`);
    const p = await prompt('attendee');
    expect(p).toMatchObject({ kind: 'membership_feedback', key: `membership:${userMembershipId}` });
    expect(p.subject).toMatchObject({ name: 'FB Gold', place: 'FB Venue' });
  });

  it('rejects an unknown prompt key', async () => {
    const res = await post('attendee', { key: 'event:nope' }, '/v1/consumer/feedback/dismiss');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('feedback_unknown_prompt');
  });

  it('rates the membership, then asks the event-type question', async () => {
    const res = await post('attendee', { kind: 'membership_feedback', id: userMembershipId, rating: 6 });
    expect(res.statusCode).toBe(200);
    const row = firstRow<Record<string, unknown>>(
      await db.execute(sql`
        select membership_id, user_membership_id, rating from user_feedback
        where user_id = ${attendeeId}::uuid and kind = 'membership_feedback'`),
    );
    expect(row).toMatchObject({ user_membership_id: userMembershipId, rating: 6 });
    // Nothing newer is due (the fresh scan is due tomorrow), so the poll is
    // next — asked of everyone, bookings or not.
    expect(await prompt('attendee')).toEqual({
      kind: 'event_type_preference',
      key: 'poll',
      question: EVENT_TYPE_QUESTION,
    });
  });

  it('"Not now" on the poll drops it; a new account has nothing more to ask', async () => {
    const res = await post('attendee', { key: 'poll' }, '/v1/consumer/feedback/dismiss');
    expect(res.statusCode).toBe(200);
    // No website survey yet either: the account is new.
    expect(await prompt('attendee')).toBeNull();
  });

  it('still takes a late rating of something past the window', async () => {
    const res = await post('attendee', { kind: 'event_feedback', id: oldEventId, rating: 4 });
    expect(res.statusCode).toBe(200);
  });

  it('asks a day-old account about the website, weekly until answered', async () => {
    await db.execute(sql`update users set created_at = now() - interval '2 days' where id = ${attendeeId}::uuid`);
    expect(await prompt('attendee')).toEqual({ kind: 'site_feedback', key: 'site', hasBooked: true });

    await post('attendee', { key: 'site' }, '/v1/consumer/feedback/dismiss');
    expect(await prompt('attendee')).toBeNull();
    // A week later it comes back.
    await db.execute(sql`
      update feedback_dismissals set dismissed_at = now() - interval '8 days'
      where user_id = ${attendeeId}::uuid and prompt_key = 'site'`);
    expect((await prompt('attendee'))?.kind).toBe('site_feedback');

    const res = await post('attendee', {
      kind: 'site_feedback',
      overallRating: 8,
      discoveryRating: 7,
      bookingRating: null,
      challenges: 'Filters were hard to find',
    });
    expect(res.statusCode).toBe(200);
    const row = firstRow<Record<string, unknown>>(
      await db.execute(sql`select * from site_feedback where user_id = ${attendeeId}::uuid`),
    );
    expect(row).toMatchObject({
      audience: 'consumer',
      overall_rating: 8,
      discovery_rating: 7,
      booking_rating: null,
      challenges: 'Filters were hard to find',
      comments: null,
      phone_e164: attendeePhone,
    });
    expect(await prompt('attendee')).toBeNull();

    const dup = await post('attendee', { kind: 'site_feedback', overallRating: 3 });
    expect(dup.statusCode).toBe(409);
  });

  it('asks a consumer with no bookings the event-type question too', async () => {
    const p = await prompt('newbie');
    expect(p).toEqual({ kind: 'event_type_preference', key: 'poll', question: EVENT_TYPE_QUESTION });
    expect(p.question.question).toBe('What kind of event would you like to see next on Circls?');
    expect(p.question.options).toContain('Other');
  });

  it('rejects a poll answer that is not one of the offered options', async () => {
    const res = await post('newbie', {
      kind: 'event_type_preference',
      questionKey: EVENT_TYPE_QUESTION.key,
      answer: 'Underwater basket weaving',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('feedback_invalid_answer');
  });

  it('"Other" needs what they typed', async () => {
    for (const other of [undefined, '   ']) {
      const res = await post('newbie', {
        kind: 'event_type_preference',
        questionKey: EVENT_TYPE_QUESTION.key,
        answer: 'Other',
        ...(other !== undefined ? { other } : {}),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('feedback_other_required');
    }
  });

  it('stores the poll answer with question snapshot + phone, once per user', async () => {
    const question = EVENT_TYPE_QUESTION;
    const res = await post('newbie', {
      kind: 'event_type_preference',
      questionKey: question.key,
      answer: 'Other',
      other: '  Pottery classes  ',
    });
    expect(res.statusCode).toBe(200);
    const row = firstRow<Record<string, unknown>>(
      await db.execute(sql`
        select phone_e164, question_key, question, answer, comment from user_feedback
        where user_id = ${newbieId}::uuid and kind = 'event_type_preference'`),
    );
    expect(row).toMatchObject({
      question_key: question.key,
      question: question.question,
      answer: 'Other',
      comment: 'Pottery classes',
    });
    expect(row['phone_e164']).toMatch(/^\+91/);

    const dup = await post('newbie', {
      kind: 'event_type_preference',
      questionKey: question.key,
      answer: question.options[0],
    });
    expect(dup.statusCode).toBe(409);
    // Poll answered, account new: nothing to ask; a day on, the website survey.
    expect(await prompt('newbie')).toBeNull();
    await db.execute(sql`update users set created_at = now() - interval '2 days' where id = ${newbieId}::uuid`);
    expect(await prompt('newbie')).toEqual({ kind: 'site_feedback', key: 'site', hasBooked: false });
  });

  it('asks about a day pass the day after it ended, not a week after it started', async () => {
    expect(await prompt('pass')).toMatchObject({
      kind: 'membership_feedback',
      key: `membership:${passMembershipId}`,
      subject: { name: 'FB Day Pass' },
    });
  });

  describe('partner survey', () => {
    const url = () => `/v1/tenants/${partnerTenantId}/feedback`;

    it('is not offered to Staff, nor for an org whose first listing is new', async () => {
      expect((await get('staff', `${url()}/prompt`)).json().prompt).toBeNull();
      const fresh = await get('owner', `/v1/tenants/${freshTenantId}/feedback/prompt`);
      expect(fresh.statusCode).toBe(200);
      expect(fresh.json().prompt).toBeNull();
    });

    it('asks Owners and Managers, noting what the org has tried', async () => {
      const res = await get('owner', `${url()}/prompt`);
      expect(res.json().prompt).toEqual({
        kind: 'partner_site_feedback',
        key: `partner:${partnerTenantId}`,
        tried: { events: false, venues: true, memberships: false },
      });
    });

    it('"Not now" snoozes only the person who said it', async () => {
      const res = await post('owner', {}, `${url()}/dismiss`);
      expect(res.statusCode).toBe(200);
      expect((await get('owner', `${url()}/prompt`)).json().prompt).toBeNull();
      expect((await get('manager', `${url()}/prompt`)).json().prompt).not.toBeNull();
    });

    it('Staff cannot answer for the org', async () => {
      const res = await post('staff', { overallRating: 5 }, url());
      expect(res.statusCode).toBe(403);
    });

    it('one answer covers the whole org', async () => {
      const res = await post('manager', {
        overallRating: 7,
        venueCreationRating: 9,
        eventCreationRating: null,
        challenges: 'Setting opening hours took a while',
        comments: 'Love it',
      }, url());
      expect(res.statusCode).toBe(200);
      const row = firstRow<Record<string, unknown>>(
        await db.execute(sql`select * from site_feedback where tenant_id = ${partnerTenantId}::uuid`),
      );
      expect(row).toMatchObject({
        audience: 'partner',
        overall_rating: 7,
        venue_creation_rating: 9,
        event_creation_rating: null,
        membership_creation_rating: null,
        email: `mgr_fb_${RUN}@x.com`,
        source: 'partners',
      });

      // Even once the Owner's snooze runs out, the org has answered.
      await db.execute(sql`update feedback_dismissals set dismissed_at = now() - interval '8 days'
                           where prompt_key = ${'partner:' + partnerTenantId}`);
      expect((await get('owner', `${url()}/prompt`)).json().prompt).toBeNull();
      const dup = await post('owner', { overallRating: 2 }, url());
      expect(dup.statusCode).toBe(409);
    });
  });

  describe('admin report', () => {
    it('needs admin.users.read', async () => {
      expect((await get('pstaff', '/v1/admin/feedback?view=ratings')).statusCode).toBe(403);
      expect((await get('owner', '/v1/admin/feedback?view=ratings')).statusCode).toBe(403);
    });

    it('lists ratings newest first, with who and what', async () => {
      const res = await get('padmin', '/v1/admin/feedback?view=ratings&kind=membership_feedback&limit=200');
      expect(res.statusCode).toBe(200);
      const body = res.json();
      const mine = body.rows.find((r: { person: { userId: string } }) => r.person.userId === attendeeId);
      expect(mine).toMatchObject({
        kind: 'membership_feedback',
        rating: 6,
        person: { phone: attendeePhone },
        tenant: { id: tenantId, name: `FB Org ${RUN}` },
        subject: { name: 'FB Gold', place: 'FB Venue' },
      });
      expect(body.summary.memberships.count).toBeGreaterThanOrEqual(1);
      expect(body.summary.events.count).toBe(0);
    });

    it('lists poll answers with the "Other" text, counted by option', async () => {
      const res = await get('padmin', '/v1/admin/feedback?view=poll&limit=200');
      expect(res.statusCode).toBe(200);
      const row = res.json().rows.find((r: { person: { userId: string } }) => r.person.userId === newbieId);
      expect(row).toMatchObject({ answer: 'Other', other: 'Pottery classes' });
      const other = res.json().summary.answers.find((a: { answer: string }) => a.answer === 'Other');
      expect(other.count).toBeGreaterThanOrEqual(1);
    });

    it('lists the partner survey with its org', async () => {
      const res = await get('padmin', '/v1/admin/feedback?view=partner&limit=200');
      const row = res.json().rows.find((r: { tenant: { id: string } | null }) => r.tenant?.id === partnerTenantId);
      expect(row).toMatchObject({ overallRating: 7, venueCreationRating: 9, eventCreationRating: null });
      expect(res.json().summary.count).toBeGreaterThanOrEqual(1);
    });

    it('only the first page carries the summary', async () => {
      const first = await get('padmin', '/v1/admin/feedback?view=ratings&limit=1');
      expect(first.json().summary).not.toBeNull();
      const second = await get('padmin', '/v1/admin/feedback?view=ratings&limit=1&cursor=1');
      expect(second.statusCode).toBe(200);
      expect(second.json().summary).toBeNull();
    });

    it('rejects an unknown view', async () => {
      expect((await get('padmin', '/v1/admin/feedback?view=nope')).statusCode).toBe(400);
    });
  });

  it('deleting the account keeps the scores but drops notes and contact snapshots', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/v1/consumer/me', headers: bearer('attendee') });
    expect(res.statusCode).toBeLessThan(300);
    const ratings = (await db.execute(sql`
      select rating, comment, phone_e164 from user_feedback
      where user_id = ${attendeeId}::uuid and kind <> 'event_type_preference'`)) as unknown as Record<string, unknown>[];
    expect(ratings.length).toBeGreaterThan(0);
    for (const r of ratings) {
      expect(r).toMatchObject({ comment: null, phone_e164: null });
      expect(r['rating']).not.toBeNull();
    }
    const site = firstRow<Record<string, unknown>>(
      await db.execute(sql`select * from site_feedback where user_id = ${attendeeId}::uuid`),
    );
    expect(site).toMatchObject({ overall_rating: 8, challenges: null, phone_e164: null, email: null });
    const left = (await db.execute(sql`
      select 1 from feedback_dismissals where user_id = ${attendeeId}::uuid`)) as unknown as unknown[];
    expect(left).toHaveLength(0);
  });
});
