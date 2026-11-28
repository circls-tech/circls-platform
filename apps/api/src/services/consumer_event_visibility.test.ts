import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db, pingDb } from '../db/client.js';
import {
  eventTicketTiers,
  events,
  tenantMembers,
  tenants,
  users,
  venues,
} from '../db/schema/index.js';
import {
  assertEventBookable,
  consumerBookEvent,
  getPublicEventById,
  listPublicEvents,
  listPublicUpcomingEvents,
  nextSeriesOccurrenceFor,
  searchPublicCatalogue,
} from './consumer_service.js';
import { createEvent, updateEvent } from './events_service.js';

const runIntegration = Boolean(process.env.RUN_INTEGRATION);

describe.skipIf(!runIntegration)('event visibility (private / invite-only)', () => {
  let tenantId: string;
  let userId: string;
  let unlistedId: string;
  let codedId: string;

  /** Insert a published standalone event with the given visibility (+1 free tier). */
  async function makeEvent(
    visibility: 'public' | 'unlisted' | 'access_code',
    accessCode: string | null,
  ) {
    const [ev] = await db
      .insert(events)
      .values({
        tenantId,
        venueId: null,
        addressJson: { line1: '5 Lake Rd', city: 'Pune' },
        tzName: 'Asia/Kolkata',
        name: `Vis ${visibility} Event`,
        startsAt: new Date('2032-08-01T10:00:00Z'),
        endsAt: new Date('2032-08-01T12:00:00Z'),
        pricePaise: 0,
        visibility,
        accessCode,
        status: 'published',
      })
      .returning();
    await db
      .insert(eventTicketTiers)
      .values({ eventId: ev!.id, tenantId, name: 'General', pricePaise: 0 });
    return ev!.id;
  }

  beforeAll(async () => {
    await pingDb();
    const [t] = await db
      .insert(tenants)
      .values({ name: 'VisOrg', slug: `visorg-${Date.now()}`, status: 'active' })
      .returning();
    tenantId = t!.id;
    const [u] = await db
      .insert(users)
      .values({ firebaseUid: `vis-fb-${Date.now()}`, email: `vis-${Date.now()}@test.x` })
      .returning();
    userId = u!.id;
    unlistedId = await makeEvent('unlisted', null);
    codedId = await makeEvent('access_code', 'Secret-Code');
  });

  afterAll(async () => {
    await db.execute(sql`delete from qr_tickets where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from notifications where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from audit_log where tenant_id = ${tenantId}`);
    await db.execute(
      sql`delete from event_booking_tickets where booking_id in (select id from bookings where tenant_id = ${tenantId})`,
    );
    await db.execute(sql`delete from bookings where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from event_ticket_tiers where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from events where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from venues where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenant_members where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
    await db.execute(sql`delete from users where id = ${userId}`);
    await closeDb();
  });

  it('hides unlisted events from the cross-venue list but resolves them by id', async () => {
    const rows = await listPublicUpcomingEvents({ limit: 100 });
    expect(rows.find((r) => r.id === unlistedId)).toBeUndefined();

    const byId = await getPublicEventById(unlistedId);
    expect(byId).toBeTruthy();
    expect(byId!.locked).toBe(false);
    expect(byId!.tiers).toHaveLength(1);
  });

  it('keeps unlisted events out of search', async () => {
    const res = await searchPublicCatalogue({ q: 'Vis unlisted Event', types: ['event'] });
    expect(res.events.find((r) => r.id === unlistedId)).toBeUndefined();
  });

  it('lists access_code events but never leaks the code', async () => {
    const rows = await listPublicUpcomingEvents({ limit: 100 });
    const row = rows.find((r) => r.id === codedId);
    expect(row).toBeTruthy();
    expect(row!.visibility).toBe('access_code');
    expect(row!.locked).toBe(true);
    expect('accessCode' in row!).toBe(false);
  });

  it('withholds the price of a locked event, and shows it once unlocked', async () => {
    await db.execute(sql`update events set price_paise = 45000 where id = ${codedId}`);
    const rows = await listPublicUpcomingEvents({ limit: 100 });
    expect(rows.find((r) => r.id === codedId)!.pricePaise).toBe(0);
    expect((await getPublicEventById(codedId))!.pricePaise).toBe(0);
    const unlocked = await getPublicEventById(codedId, { accessCode: 'secret-code' });
    expect(unlocked!.pricePaise).toBe(45000);
    await db.execute(sql`update events set price_paise = 0 where id = ${codedId}`);
  });

  it('marks a venue list row locked and never rolls a saved date onto a private-link one', async () => {
    const [venue] = await db
      .insert(venues)
      .values({
        tenantId,
        name: 'Vis Venue',
        addressJson: { line1: '1 Court Rd', city: 'Pune' },
        tzName: 'Asia/Kolkata',
        status: 'active',
      })
      .returning();
    const seriesId = randomUUID();
    const base = {
      tenantId,
      venueId: venue!.id,
      name: 'Vis Series',
      pricePaise: 20000,
      status: 'published' as const,
      seriesId,
    };
    const [past, hidden, coded] = await db
      .insert(events)
      .values([
        { ...base, startsAt: new Date('2020-01-01T10:00:00Z'), endsAt: new Date('2020-01-01T12:00:00Z') },
        {
          ...base,
          startsAt: new Date('2032-09-01T10:00:00Z'),
          endsAt: new Date('2032-09-01T12:00:00Z'),
          visibility: 'unlisted' as const,
        },
        {
          ...base,
          startsAt: new Date('2032-09-08T10:00:00Z'),
          endsAt: new Date('2032-09-08T12:00:00Z'),
          visibility: 'access_code' as const,
          accessCode: 'Series-Code',
        },
      ])
      .returning();

    const rows = await listPublicEvents(venue!.id);
    expect(rows.map((r) => r.id)).toEqual([coded!.id]);
    expect(rows[0]!.locked).toBe(true);
    expect(rows[0]!.pricePaise).toBe(0);
    expect('accessCode' in rows[0]!).toBe(false);

    // The earlier upcoming date is private-link: skip it for the listed one.
    const next = await nextSeriesOccurrenceFor([past!.id]);
    expect(next.get(past!.id)).toBe(coded!.id);
    expect(next.get(past!.id)).not.toBe(hidden!.id);
  });

  it('keeps an access_code event locked (no tiers) without or with a wrong code', async () => {
    const noCode = await getPublicEventById(codedId);
    expect(noCode!.locked).toBe(true);
    expect(noCode!.tiers).toHaveLength(0);
    expect('accessCode' in noCode!).toBe(false);

    const wrong = await getPublicEventById(codedId, { accessCode: 'nope' });
    expect(wrong!.locked).toBe(true);
    expect(wrong!.tiers).toHaveLength(0);
  });

  it('unlocks with the right code, case-insensitively', async () => {
    const unlocked = await getPublicEventById(codedId, { accessCode: '  secret-code ' });
    expect(unlocked!.locked).toBe(false);
    expect(unlocked!.tiers).toHaveLength(1);
  });

  it('refuses to book an access_code event without the code, and books with it', async () => {
    const [tier] = await db
      .select()
      .from(eventTicketTiers)
      .where(sql`${eventTicketTiers.eventId} = ${codedId}`);
    const lines = [{ tierId: tier!.id, quantity: 1 }];

    await expect(consumerBookEvent(codedId, { userId }, lines)).rejects.toMatchObject({
      code: 'event_access_code_invalid',
    });
    await expect(
      consumerBookEvent(codedId, { userId }, lines, undefined, [], 'wrong'),
    ).rejects.toMatchObject({ code: 'event_access_code_invalid' });

    const res = await consumerBookEvent(codedId, { userId }, lines, undefined, [], 'SECRET-code');
    expect(res.booking.status).toBe('confirmed');
  });

  it('lets the team that runs the event through without the code, and nobody else', async () => {
    await expect(assertEventBookable(codedId, { staffUserId: userId })).rejects.toMatchObject({
      code: 'event_access_code_invalid',
    });
    await db.insert(tenantMembers).values({ tenantId, userId, role: 'staff' });
    await expect(assertEventBookable(codedId, { staffUserId: userId })).resolves.toBeUndefined();
    await db.execute(sql`delete from tenant_members where tenant_id = ${tenantId}`);
  });

  it('books an unlisted event without any code', async () => {
    const [tier] = await db
      .select()
      .from(eventTicketTiers)
      .where(sql`${eventTicketTiers.eventId} = ${unlistedId}`);
    const res = await consumerBookEvent(unlistedId, { userId }, [
      { tierId: tier!.id, quantity: 1 },
    ]);
    expect(res.booking.status).toBe('confirmed');
  });

  it('rejects creating an access_code event without a code', async () => {
    await expect(
      createEvent(
        { tenantId, actorUserId: userId },
        {
          tenantId,
          addressJson: { line1: '5 Lake Rd', city: 'Pune' },
          tzName: 'Asia/Kolkata',
          name: 'No Code',
          startsAt: new Date('2032-08-02T10:00:00Z'),
          endsAt: new Date('2032-08-02T12:00:00Z'),
          tiers: [{ name: 'General', description: null, pricePaise: 0, capacity: null }],
          visibility: 'access_code',
        },
      ),
    ).rejects.toMatchObject({ code: 'event_access_code_required' });
  });

  it('lets a PUBLISHED event change visibility/code as a live setting, but nothing else', async () => {
    const ctx = { tenantId, actorUserId: userId };
    const updated = await updateEvent(ctx, codedId, { accessCode: 'New-Code-42' });
    expect(updated.accessCode).toBe('New-Code-42');

    const toUnlisted = await updateEvent(ctx, codedId, { visibility: 'unlisted' });
    expect(toUnlisted.visibility).toBe('unlisted');

    // Leaving access_code discards the code: coming back needs a new one,
    // never the old one revived.
    expect(toUnlisted.accessCode).toBeNull();
    await expect(updateEvent(ctx, codedId, { visibility: 'access_code' })).rejects.toMatchObject({
      code: 'event_access_code_required',
    });
    await updateEvent(ctx, codedId, { visibility: 'access_code', accessCode: 'Fresh-Code-7' });
    // Dropping the code while access_code is on must fail.
    await expect(updateEvent(ctx, codedId, { accessCode: null })).rejects.toMatchObject({
      code: 'event_access_code_required',
    });

    // The code never reaches the audit log — only that it changed.
    const audit = await db.execute(
      sql`select before::text as b, after::text as a from audit_log where tenant_id = ${tenantId}`,
    );
    const logged = JSON.stringify(audit);
    expect(logged).not.toContain('New-Code-42');
    expect(logged).not.toContain('Fresh-Code-7');
    expect(logged).toContain('accessCodeChanged');

    // Content stays frozen on live events.
    await expect(updateEvent(ctx, codedId, { name: 'Renamed' })).rejects.toMatchObject({
      code: 'event_not_draft',
    });
  });
});
