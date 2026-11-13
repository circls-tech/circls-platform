import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { closeDb, db, pingDb } = await import('../db/client.js');
const { memberships, tenants, users } = await import('../db/schema/index.js');
const { eq } = await import('drizzle-orm');
const { createMembership, getMembership, regroupMembershipTiers, updateMembership } = await import(
  './memberships_service.js'
);
const { getPublicMembershipById } = await import('./consumer_service.js');

const runIntegration = Boolean(process.env.RUN_INTEGRATION);

const DAY = { key: 'day-passes', name: 'Day Passes', tagline: 'For first-timers.' };
const PUNCH = { key: 'punch-passes', name: 'Punch Passes', tagline: null };

function tier(name: string, pricePaise: number, groupKey?: string | null) {
  return {
    name,
    pricePaise,
    durationDays: 30,
    benefits: { items: [] },
    capacity: null,
    ...(groupKey !== undefined ? { groupKey } : {}),
  };
}

describe.skipIf(!runIntegration)('membership plan groups', () => {
  let tenantId: string;
  let actorUserId: string;
  const ctx = () => ({ tenantId, actorUserId });

  beforeAll(async () => {
    await pingDb();
    const [t] = await db
      .insert(tenants)
      .values({ name: 'GroupCo', slug: `groupco-${Date.now()}` })
      .returning();
    tenantId = t!.id;
    const [u] = await db
      .insert(users)
      .values({ firebaseUid: `grp-fb-${Date.now()}`, email: `grp-${Date.now()}@x.com` })
      .returning();
    actorUserId = u!.id;
  });

  afterAll(async () => {
    await closeDb();
  });

  async function makeGrouped() {
    return createMembership({
      tenantId,
      actorUserId,
      name: `Climbing ${Date.now()}`,
      tierGroups: [DAY, PUNCH],
      tiers: [tier('Day Pass', 65000, 'day-passes'), tier('5-Visit Pass', 275000, 'punch-passes'), tier('Loose', 1000)],
    });
  }

  it('creates a membership with groups and puts each plan in its group', async () => {
    const m = await makeGrouped();
    expect(m.tierGroups).toEqual([DAY, PUNCH]);
    expect(m.tiers.map((t) => [t.name, t.groupKey])).toEqual([
      ['Day Pass', 'day-passes'],
      ['5-Visit Pass', 'punch-passes'],
      ['Loose', null],
    ]);
  });

  it('rejects a plan in a group the membership does not have', async () => {
    await expect(
      createMembership({
        tenantId,
        actorUserId,
        name: 'Bad group',
        tierGroups: [DAY],
        tiers: [tier('Day Pass', 65000, 'punch-passes')],
      }),
    ).rejects.toMatchObject({ code: 'membership_tier_group_unknown' });
  });

  it('keeps the groups when an app that predates them re-saves the plans', async () => {
    const m = await makeGrouped();
    // No groupKey on any tier, as the old partners app sends them.
    const updated = await updateMembership(ctx(), m.id, {
      tiers: [tier('Day Pass', 70000), tier('5-Visit Pass', 275000), tier('Loose', 1000)],
    });
    expect(updated.tiers.map((t) => t.groupKey)).toEqual(['day-passes', 'punch-passes', null]);
  });

  it('ungroups the plans of a group removed by a PATCH', async () => {
    const m = await makeGrouped();
    const updated = await updateMembership(ctx(), m.id, { tierGroups: [DAY] });
    expect(updated.tierGroups).toEqual([DAY]);
    expect(updated.tiers.map((t) => t.groupKey)).toEqual(['day-passes', null, null]);
  });

  it('regroups and reorders a live membership without replacing its plans', async () => {
    const m = await makeGrouped();
    await db.update(memberships).set({ status: 'active' }).where(eq(memberships.id, m.id));
    const [day, punch, loose] = m.tiers;
    const classes = { key: 'classes', name: 'Classes', tagline: 'Learn and improve.' };

    const regrouped = await regroupMembershipTiers(ctx(), m.id, {
      tierGroups: [PUNCH, classes],
      tiers: [
        { id: punch!.id, groupKey: 'punch-passes' },
        { id: loose!.id, groupKey: 'classes' },
        { id: day!.id, groupKey: null },
      ],
    });

    expect(regrouped.status).toBe('active');
    expect(regrouped.tierGroups).toEqual([PUNCH, classes]);
    // Same plans (ids, prices), new order and groups.
    expect(regrouped.tiers.map((t) => [t.id, t.groupKey, t.pricePaise])).toEqual([
      [punch!.id, 'punch-passes', 275000],
      [loose!.id, 'classes', 1000],
      [day!.id, null, 65000],
    ]);
    // A live membership still can't change its plans' prices.
    await expect(updateMembership(ctx(), m.id, { tiers: [tier('Day Pass', 1)] })).rejects.toMatchObject({
      code: 'membership_not_editable',
    });
  });

  it('refuses a regroup that leaves out a plan or names an unknown group', async () => {
    const m = await makeGrouped();
    const [day, punch, loose] = m.tiers;
    await expect(
      regroupMembershipTiers(ctx(), m.id, {
        tierGroups: [DAY],
        tiers: [{ id: day!.id, groupKey: 'day-passes' }],
      }),
    ).rejects.toMatchObject({ code: 'membership_tiers_mismatch' });
    await expect(
      regroupMembershipTiers(ctx(), m.id, {
        tierGroups: [DAY],
        tiers: [
          { id: day!.id, groupKey: 'day-passes' },
          { id: punch!.id, groupKey: 'punch-passes' },
          { id: loose!.id, groupKey: null },
        ],
      }),
    ).rejects.toMatchObject({ code: 'membership_tier_group_unknown' });
    // Nothing changed.
    const after = await getMembership(m.id, tenantId);
    expect(after?.tierGroups).toEqual([DAY, PUNCH]);
  });

  it('shows customers only the groups that have plans', async () => {
    const m = await createMembership({
      tenantId,
      actorUserId,
      name: `Public ${Date.now()}`,
      tierGroups: [DAY, PUNCH],
      tiers: [tier('Day Pass', 65000, 'day-passes'), tier('Loose', 1000)],
    });
    await db.update(memberships).set({ status: 'active' }).where(eq(memberships.id, m.id));
    const pub = await getPublicMembershipById(m.id);
    expect(pub?.tierGroups).toEqual([DAY]);
    expect(pub?.tiers.map((t) => [t.name, t.groupKey])).toEqual([
      ['Day Pass', 'day-passes'],
      ['Loose', null],
    ]);
  });
});
