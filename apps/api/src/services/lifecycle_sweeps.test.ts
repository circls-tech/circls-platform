import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { closeDb, db, pingDb } = await import('../db/client.js');
const { events, tenants, users } = await import('../db/schema/index.js');
const { sql } = await import('drizzle-orm');
const { autoArchiveEndedEvents, expireLapsedMemberships } = await import('./lifecycle_sweeps.js');
const { addExternalMember, createMembership, purchaseMembership, updateMember } = await import(
  './memberships_service.js'
);
const { validateQrTicket } = await import('./qr_ticket_service.js');
const { setEventArchived } = await import('./events_service.js');

const runIntegration = Boolean(process.env.RUN_INTEGRATION);

const DAY = 24 * 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms);
const ahead = (ms: number) => new Date(Date.now() + ms);

/*
 * Both sweeps are global — they act on every tenant's rows. That is safe here
 * because API test files run one at a time (vitest.config.ts), and every
 * assertion below reads back this file's own rows rather than trusting the
 * sweep's return count, which also includes anything an earlier file left.
 */
describe.skipIf(!runIntegration)('lifecycle sweeps', () => {
  let tenantId: string;
  let actorUserId: string;

  beforeAll(async () => {
    await pingDb();
    const stamp = Date.now();
    const [t] = await db
      .insert(tenants)
      .values({ name: 'Sweep Co', slug: `sweepco-${stamp}` })
      .returning();
    tenantId = t!.id;
    const [u] = await db
      .insert(users)
      .values({ firebaseUid: `sweep-fb-${stamp}`, email: `sweep-${stamp}@x.com` })
      .returning();
    actorUserId = u!.id;
  });

  afterAll(async () => {
    await closeDb();
  });

  describe('membership expiry', () => {
    let planId: string;

    beforeAll(async () => {
      const plan = await createMembership({
        tenantId,
        actorUserId,
        name: `Sweep plan ${Date.now()}`,
        pricePaise: 0,
        durationDays: 30,
      });
      planId = plan.id;
    });

    async function member(name: string, startsAt: Date, endsAt: Date) {
      const { userMembershipId } = await addExternalMember(
        { tenantId, actorUserId },
        { membershipId: planId, name, startsAt, endsAt },
      );
      return userMembershipId;
    }

    async function statusOf(id: string): Promise<string> {
      const rows = (await db.execute(
        sql`select status from user_memberships where id = ${id}::uuid`,
      )) as unknown as { status: string }[];
      return rows[0]!.status;
    }

    it('expires a membership that ended more than a day ago, and says so in the audit log', async () => {
      const id = await member('Lapsed Lata', ago(40 * DAY), ago(3 * DAY));

      await expireLapsedMemberships();

      expect(await statusOf(id)).toBe('expired');
      const audit = (await db.execute(sql`
        select actor_user_id, tenant_id, before, after
          from audit_log
         where entity_id = ${id}::uuid and action = 'membership.member_expired'
      `)) as unknown as {
        actor_user_id: string | null;
        tenant_id: string;
        before: { status: string };
        after: { status: string };
      }[];
      expect(audit).toHaveLength(1);
      // No person did this — the clock did. A null actor is how the audit log
      // already records system-initiated changes.
      expect(audit[0]!.actor_user_id).toBeNull();
      expect(audit[0]!.tenant_id).toBe(tenantId);
      expect(audit[0]!.before.status).toBe('active');
      expect(audit[0]!.after.status).toBe('expired');
    });

    it('waits the full day: a membership that ended hours ago stays active', async () => {
      const id = await member('Last Night Lakshmi', ago(30 * DAY), ago(6 * 60 * 60 * 1000));
      await expireLapsedMemberships();
      expect(await statusOf(id)).toBe('active');
    });

    it('leaves a current membership alone', async () => {
      const id = await member('Current Chitra', ago(DAY), ahead(20 * DAY));
      await expireLapsedMemberships();
      expect(await statusOf(id)).toBe('active');
    });

    // Cancelled is a decision someone made; the clock must not overwrite it.
    it('never turns a cancelled membership into an expired one', async () => {
      const id = await member('Cancelled Kavya', ago(40 * DAY), ago(5 * DAY));
      await updateMember({ tenantId, actorUserId }, id, planId, { status: 'cancelled' });
      await expireLapsedMemberships();
      expect(await statusOf(id)).toBe('cancelled');
    });

    it('is idempotent: a second run writes no second audit row', async () => {
      const id = await member('Twice Tara', ago(40 * DAY), ago(4 * DAY));
      await expireLapsedMemberships();
      await expireLapsedMemberships();
      const audit = (await db.execute(sql`
        select 1 from audit_log
         where entity_id = ${id}::uuid and action = 'membership.member_expired'
      `)) as unknown as unknown[];
      expect(audit).toHaveLength(1);
    });

    // The sweep only moves active → expired, so without the renewal a partner
    // correcting someone's dates would leave them expired and out of the
    // customer's own list.
    it('renews an expired member when a partner extends their window into the future', async () => {
      const id = await member('Renewed Radha', ago(40 * DAY), ago(3 * DAY));
      await expireLapsedMemberships();
      expect(await statusOf(id)).toBe('expired');

      await updateMember({ tenantId, actorUserId }, id, planId, { endsAt: ahead(30 * DAY) });
      expect(await statusOf(id)).toBe('active');
    });

    it('does not renew when the corrected window is still in the past', async () => {
      const id = await member('Backdated Bina', ago(40 * DAY), ago(3 * DAY));
      await expireLapsedMemberships();

      await updateMember({ tenantId, actorUserId }, id, planId, { endsAt: ago(2 * DAY) });
      expect(await statusOf(id)).toBe('expired');
    });
  });

  // The whole story for a partner: a member lapses, the sweep expires them, a
  // partner extends their dates — and they must get through the door again.
  // A pass keeps its own copy of its validity window, so without re-deriving
  // it the door still said "Expired" after the membership was renewed.
  describe('renewing an expired member with an entry pass', () => {
    it('moves the pass window with the dates, so the door lets them back in', async () => {
      const stamp = Date.now();
      const [buyer] = await db
        .insert(users)
        .values({ firebaseUid: `sweep-buyer-${stamp}`, email: `sweep-buyer-${stamp}@x.com` })
        .returning();
      const plan = await createMembership({
        tenantId,
        actorUserId,
        name: `Pass plan ${stamp}`,
        pricePaise: 0,
        durationDays: 30,
      });
      await db.execute(sql`
        update memberships
           set qr_ticket_config = ${JSON.stringify({
             enabled: true,
             multiUse: true,
             maxScans: null,
             validFromOffsetMin: null,
             validUntilOffsetMin: null,
           })}::jsonb
         where id = ${plan.id}::uuid
      `);

      const { userMembershipId } = await purchaseMembership({
        membershipId: plan.id,
        userId: buyer!.id,
      });

      // Make it a membership that ran out three days ago — pass included.
      const lapsed = ago(3 * DAY);
      await db.execute(sql`
        update user_memberships set starts_at = ${ago(33 * DAY).toISOString()}::timestamptz,
                                    ends_at   = ${lapsed.toISOString()}::timestamptz
         where id = ${userMembershipId}::uuid
      `);
      await db.execute(sql`
        update qr_tickets set valid_until = ${lapsed.toISOString()}::timestamptz
         where user_membership_id = ${userMembershipId}::uuid
      `);
      const [pass] = (await db.execute(sql`
        select code from qr_tickets where user_membership_id = ${userMembershipId}::uuid
      `)) as unknown as { code: string }[];
      expect(pass).toBeTruthy();

      await expireLapsedMemberships();
      expect(
        (await validateQrTicket({ tenantId, actorUserId }, pass!.code, { consume: false }))
          .outcome,
      ).toBe('expired');

      const renewedTo = ahead(30 * DAY);
      await updateMember({ tenantId, actorUserId }, userMembershipId, plan.id, {
        endsAt: renewedTo,
      });

      const scan = await validateQrTicket({ tenantId, actorUserId }, pass!.code, {
        consume: false,
      });
      expect(scan.outcome).toBe('valid');
      expect(new Date(scan.ticket!.validUntil!).getTime()).toBe(renewedTo.getTime());
    });

    // Cancelling doesn't revoke the pass, so moving its window would hand a
    // live pass to someone who is no longer a member.
    it("leaves a cancelled member's pass where it was when their dates are edited", async () => {
      const stamp = Date.now();
      const [buyer] = await db
        .insert(users)
        .values({ firebaseUid: `sweep-cx-${stamp}`, email: `sweep-cx-${stamp}@x.com` })
        .returning();
      const plan = await createMembership({
        tenantId,
        actorUserId,
        name: `Cancelled pass plan ${stamp}`,
        pricePaise: 0,
        durationDays: 30,
      });
      await db.execute(sql`
        update memberships
           set qr_ticket_config = ${JSON.stringify({
             enabled: true,
             multiUse: true,
             maxScans: null,
             validFromOffsetMin: null,
             validUntilOffsetMin: null,
           })}::jsonb
         where id = ${plan.id}::uuid
      `);
      const { userMembershipId } = await purchaseMembership({
        membershipId: plan.id,
        userId: buyer!.id,
      });
      const [before] = (await db.execute(sql`
        select valid_until from qr_tickets where user_membership_id = ${userMembershipId}::uuid
      `)) as unknown as { valid_until: Date }[];

      await updateMember({ tenantId, actorUserId }, userMembershipId, plan.id, {
        status: 'cancelled',
      });
      await updateMember({ tenantId, actorUserId }, userMembershipId, plan.id, {
        endsAt: ahead(90 * DAY),
      });

      const [after] = (await db.execute(sql`
        select valid_until from qr_tickets where user_membership_id = ${userMembershipId}::uuid
      `)) as unknown as { valid_until: Date }[];
      expect(new Date(after!.valid_until).getTime()).toBe(new Date(before!.valid_until).getTime());
    });
  });

  describe('event auto-archive', () => {
    async function event(
      name: string,
      status: 'draft' | 'pending_review' | 'published' | 'cancelled' | 'completed',
      endsAt: Date,
    ) {
      const [e] = await db
        .insert(events)
        .values({
          tenantId,
          venueId: null,
          addressJson: { line1: '1 Sweep St', city: 'Pune' },
          tzName: 'Asia/Kolkata',
          name,
          startsAt: new Date(endsAt.getTime() - 2 * 60 * 60 * 1000),
          endsAt,
          pricePaise: 0,
          status,
        })
        .returning();
      return e!.id;
    }

    async function read(id: string) {
      const rows = (await db.execute(sql`
        select status, archived_at, auto_archived_at from events where id = ${id}::uuid
      `)) as unknown as {
        status: string;
        archived_at: Date | null;
        auto_archived_at: Date | null;
      }[];
      return rows[0]!;
    }

    // A published event is never archived elsewhere in the code, so one that
    // has run moves to `completed` — which already means "it ran, or is over".
    it('archives a published event a day after it ends, completing it on the way', async () => {
      const id = await event('Ran Last Week', 'published', ago(3 * DAY));

      await autoArchiveEndedEvents();

      const e = await read(id);
      expect(e.status).toBe('completed');
      expect(e.archived_at).not.toBeNull();
      expect(e.auto_archived_at).not.toBeNull();

      const audit = (await db.execute(sql`
        select actor_user_id, before, after from audit_log
         where entity_id = ${id}::uuid and action = 'event.auto_archived'
      `)) as unknown as {
        actor_user_id: string | null;
        before: { status: string; archived: boolean };
        after: { status: string; archived: boolean };
      }[];
      expect(audit).toHaveLength(1);
      expect(audit[0]!.actor_user_id).toBeNull();
      expect(audit[0]!.before).toEqual({ status: 'published', archived: false });
      expect(audit[0]!.after).toEqual({ status: 'completed', archived: true });
    });

    it('archives a cancelled event without changing its status', async () => {
      const id = await event('Called Off', 'cancelled', ago(4 * DAY));
      await autoArchiveEndedEvents();
      const e = await read(id);
      expect(e.status).toBe('cancelled');
      expect(e.archived_at).not.toBeNull();
    });

    it('waits the full day: an event that ended hours ago is left on the working list', async () => {
      const id = await event('Finished Tonight', 'published', ago(5 * 60 * 60 * 1000));
      await autoArchiveEndedEvents();
      const e = await read(id);
      expect(e.status).toBe('published');
      expect(e.archived_at).toBeNull();
    });

    // Matches the manual rule: an event still in the admin review queue
    // cannot be archived by hand either.
    it('leaves an event awaiting review alone', async () => {
      const id = await event('Still In Review', 'pending_review', ago(6 * DAY));
      await autoArchiveEndedEvents();
      const e = await read(id);
      expect(e.status).toBe('pending_review');
      expect(e.archived_at).toBeNull();
    });

    it('leaves an event the partner already archived by hand as they left it', async () => {
      const id = await event('Shelved By Hand', 'completed', ago(5 * DAY));
      await setEventArchived({ tenantId, actorUserId }, id, true);
      await autoArchiveEndedEvents();
      const e = await read(id);
      expect(e.archived_at).not.toBeNull();
      // Recorded as the partner's archive, not the sweep's.
      expect(e.auto_archived_at).toBeNull();
    });

    // The reason `auto_archived_at` exists: without it the next hourly run
    // would quietly overrule the partner.
    it('does not re-archive an event the partner restored from the archive', async () => {
      const id = await event('Pulled Back Out', 'cancelled', ago(3 * DAY));
      await autoArchiveEndedEvents();
      expect((await read(id)).archived_at).not.toBeNull();

      await setEventArchived({ tenantId, actorUserId }, id, false);
      expect((await read(id)).archived_at).toBeNull();

      await autoArchiveEndedEvents();
      expect((await read(id)).archived_at).toBeNull();
    });
  });
});
