import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// env.ts is parsed once at import; set the admin list before anything loads it.
// vitest.setup.ts clears ADMIN_TEAM_EMAILS for every other file, so the rest
// of the suite never mails the team.
vi.hoisted(() => {
  process.env.ADMIN_TEAM_EMAILS = ' ops@circls.test, founders@circls.test ,,';
});

import { closeDb, db, pingDb } from '../db/client.js';
import {
  arenas,
  bookings,
  notifications,
  questionMessages,
  questionThreads,
  tenantMembers,
  tenants,
  users,
  venues,
} from '../db/schema/index.js';
import { __resetNotificationsForTesting } from '../lib/notifications/index.js';
import {
  notifyAdminTeam,
  notifyBookingCancelled,
  notifyBookingConfirmed,
  notifyBookingRefunded,
  notifyListingReviewed,
  notifyListingSubmitted,
  notifyOrgCreated,
  notifyQuestionAsked,
  partnerEmailKind,
  partnerRecipients,
} from './notification_service.js';
import { addConsumerMessage, addOrgMessage } from './questions_service.js';
import { updateTenantProfile } from './tenant_service.js';
import { resolveEmailPrefs } from '../db/schema/tenants.js';

describe('partner email preferences (unit)', () => {
  it('treats a missing kind as on', () => {
    expect(resolveEmailPrefs(null)).toEqual({ booking: true, listing: true });
    expect(resolveEmailPrefs({ listing: false })).toEqual({ booking: true, listing: false });
  });

  it('maps each partner email to the switch that governs it', () => {
    expect(partnerEmailKind('partner.booking_confirmed')).toBe('booking');
    expect(partnerEmailKind('listing.approved')).toBe('listing');
    expect(partnerEmailKind('listing.rejected')).toBe('listing');
    // Not switchable: always sent.
    expect(partnerEmailKind('question.asked')).toBeNull();
    expect(partnerEmailKind('tenant.invitation')).toBeNull();
  });
});

const runIntegration = Boolean(process.env.RUN_INTEGRATION);

describe.skipIf(!runIntegration)('partner + admin-team emails (integration)', () => {
  let tenantId: string;
  let platformTenantId: string;
  let ownerUserId: string;
  let askerUserId: string;
  let venueId: string;
  let arenaId: string;
  const ownerEmail = `owner-${Date.now()}@circls.test`;

  beforeAll(async () => {
    await pingDb();
    __resetNotificationsForTesting();
    const [u] = await db
      .insert(users)
      .values({ firebaseUid: `notif-admin-${Date.now()}`, email: ownerEmail, displayName: 'Olivia Owner' })
      .returning();
    ownerUserId = u!.id;
    const [asker] = await db
      .insert(users)
      .values({ firebaseUid: `notif-asker-${Date.now()}`, displayName: 'Asha Asker' })
      .returning();
    askerUserId = asker!.id;
    const [t] = await db
      .insert(tenants)
      .values({ name: 'Admin Alert Co', slug: `admin-alert-${Date.now()}`, country: 'India' })
      .returning();
    tenantId = t!.id;
    await db.insert(tenantMembers).values({ userId: ownerUserId, tenantId, role: 'owner' });
    // A stand-in Circls tenant (random slug, so nothing else resolves it as
    // the real one) with the same owner and no contact email.
    const [p] = await db
      .insert(tenants)
      .values({ name: 'Circls Test', slug: `circls-test-${Date.now()}`, country: 'India', isPlatform: true })
      .returning();
    platformTenantId = p!.id;
    await db.insert(tenantMembers).values({ userId: ownerUserId, tenantId: platformTenantId, role: 'owner' });
    const [v] = await db
      .insert(venues)
      .values({ tenantId, name: 'Alert Arena', tzName: 'Asia/Kolkata' })
      .returning();
    venueId = v!.id;
    const [a] = await db.insert(arenas).values({ venueId, name: 'Court A' }).returning();
    arenaId = a!.id;
  });

  afterAll(async () => {
    const ids = sql`(${tenantId}, ${platformTenantId})`;
    await db.execute(sql`delete from notifications where tenant_id in ${ids}`);
    await db.execute(sql`delete from audit_log where tenant_id = ${tenantId}`);
    await db.execute(
      sql`delete from question_messages where thread_id in (select id from question_threads where tenant_id in ${ids})`,
    );
    await db.execute(sql`delete from question_threads where tenant_id in ${ids}`);
    await db.execute(sql`delete from bookings where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from arenas where id = ${arenaId}`);
    await db.execute(sql`delete from venues where id = ${venueId}`);
    await db.execute(sql`delete from tenant_members where tenant_id in ${ids}`);
    await db.execute(sql`delete from tenants where id in ${ids}`);
    await db.execute(sql`delete from users where id in (${ownerUserId}, ${askerUserId})`);
    await closeDb();
  });

  let bookingSeq = 0;
  // Each booking gets its own hour: the arena has an overlap exclusion constraint.
  async function insertBooking(channel: 'circls' | 'walkin', name: string) {
    bookingSeq += 1;
    const startAt = new Date(Date.now() + (3 * 24 + 2 * bookingSeq) * 60 * 60 * 1000);
    const endAt = new Date(startAt.getTime() + 60 * 60 * 1000);
    const [b] = await db
      .insert(bookings)
      .values({
        tenantId,
        venueId,
        itemType: 'slot',
        slotArenaId: arenaId,
        timeRange: `[${startAt.toISOString()},${endAt.toISOString()})`,
        channel,
        paymentMethod: channel === 'walkin' ? 'external' : 'razorpay_route',
        status: 'confirmed',
        customerName: name,
        customerContact: '+919999900001',
        customerContactJson: { phone: '+919999900001', email: 'alert@example.com' },
        totalPaise: 75000,
        currency: 'INR',
      })
      .returning();
    return b!.id;
  }

  const rowsFor = async (key: string, where = sql`true`) =>
    db
      .select()
      .from(notifications)
      .where(sql`tenant_id = ${tenantId} and template_key = ${key} and ${where}`);

  async function askQuestion(onTenant: string, body: string) {
    const [t] = await db
      .insert(questionThreads)
      .values({
        tenantId: onTenant,
        subjectType: onTenant === tenantId ? 'arena' : 'general',
        arenaId: onTenant === tenantId ? arenaId : null,
        visibility: 'private',
        authorUserId: askerUserId,
      })
      .returning();
    await db.insert(questionMessages).values({ threadId: t!.id, authorUserId: askerUserId, authorKind: 'consumer', body });
    await notifyQuestionAsked(t!.id);
    return t!.id;
  }

  it('notifyQuestionAsked emails the owners when the org has no contact email', async () => {
    const threadId = await askQuestion(tenantId, 'Is there parking?');
    const rows = await db.select().from(notifications).where(sql`template_key = 'question.asked' and payload->>'portalUrl' like ${'%' + threadId}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.recipient).toBe(ownerEmail);
    expect(rows[0]!.payload).toMatchObject({ greetingName: 'Olivia', subjectName: 'Court A', excerpt: 'Is there parking?' });

    // The Circls tenant keeps to its contact email: none, so no email.
    const general = await askQuestion(platformTenantId, 'How do refunds work?');
    expect(
      await db.select().from(notifications).where(sql`template_key = 'question.asked' and payload->>'portalUrl' like ${'%' + general}`),
    ).toHaveLength(0);
  });

  it('partnerRecipients prefers contact_email and falls back to the owners, greeted by name', async () => {
    expect(await partnerRecipients(tenantId)).toEqual([{ email: ownerEmail, greetingName: 'Olivia' }]);
    await db.update(tenants).set({ contactEmail: 'front-desk@circls.test' }).where(sql`id = ${tenantId}`);
    expect(await partnerRecipients(tenantId)).toEqual([
      { email: 'front-desk@circls.test', greetingName: 'Admin Alert Co' },
    ]);
  });

  it('notifyQuestionAsked emails only the contact email once it is set', async () => {
    const threadId = await askQuestion(tenantId, 'Do you rent rackets?');
    const rows = await db.select().from(notifications).where(sql`template_key = 'question.asked' and payload->>'portalUrl' like ${'%' + threadId}`);
    expect(rows.map((r) => r.recipient)).toEqual(['front-desk@circls.test']);
    expect(rows[0]!.payload).toMatchObject({ greetingName: 'Admin Alert Co' });
  });

  it('the asker following up emails the org once per org reply', async () => {
    const threadId = await askQuestion(tenantId, 'Can I bring a friend?');
    const followUps = () =>
      db.select().from(notifications).where(sql`template_key = 'question.followed_up' and payload->>'portalUrl' like ${'%' + threadId}`);

    // Before the org has replied, the question email already covers it.
    await addConsumerMessage({ threadId, userId: askerUserId, body: 'Also, is there a changing room?' });
    expect(await followUps()).toHaveLength(0);

    await addOrgMessage({ tenantId, threadId, userId: ownerUserId, body: 'Yes to both.' });
    await addConsumerMessage({ threadId, userId: askerUserId, body: 'Great, and towels?' });
    const rows = await followUps();
    expect(rows.map((r) => r.recipient)).toEqual(['front-desk@circls.test']);
    expect(rows[0]!.payload).toMatchObject({ excerpt: 'Great, and towels?', subjectName: 'Court A' });

    // A second follow-up before the org replies again sends nothing more.
    await addConsumerMessage({ threadId, userId: askerUserId, body: 'Or should I bring my own?' });
    expect(await followUps()).toHaveLength(1);
  });

  it('notifyBookingConfirmed emails the org about a customer booking, not a desk booking', async () => {
    const online = await insertBooking('circls', 'Asha');
    await notifyBookingConfirmed(online);
    const partnerRows = await rowsFor('partner.booking_confirmed', sql`payload->>'bookingId' = ${online}`);
    expect(partnerRows).toHaveLength(1);
    expect(partnerRows[0]!.recipient).toBe('front-desk@circls.test');
    expect(partnerRows[0]!.status).toBe('sent');
    expect(partnerRows[0]!.payload).toMatchObject({
      customerFirst: 'Asha',
      customerShort: 'Asha',
      listingName: 'Alert Arena · Court A',
      ctaLabel: 'View bookings',
      greetingName: 'Admin Alert Co',
    });
    expect(partnerRows[0]!.payload['rows']).toContainEqual({ label: 'Amount paid', value: '₹750' });
    expect(String(partnerRows[0]!.payload['ctaUrl'])).toContain(`/venues/${venueId}/bookings`);
    // The customer's own confirmation is untouched: one SMS + one email.
    const customerRows = await rowsFor('booking.confirmed', sql`payload->>'bookingId' = ${online}`);
    expect(customerRows.map((r) => r.channel).sort()).toEqual(['email', 'sms']);

    const desk = await insertBooking('walkin', 'Walk In');
    await notifyBookingConfirmed(desk);
    expect(await rowsFor('partner.booking_confirmed', sql`payload->>'bookingId' = ${desk}`)).toHaveLength(0);
  });

  it('notifyBookingRefunded tells the customer the amount and why, and skips failed refunds', async () => {
    const bookingId = await insertBooking('circls', 'Ravi');
    await notifyBookingRefunded(bookingId, {
      amountPaise: 25000,
      status: 'processed',
      refundPaymentId: '0193a2b4-0000-7000-8000-0000000071kq',
      reason: { kind: 'manual' },
    });
    const rows = await rowsFor('booking.refunded', sql`payload->>'bookingId' = ${bookingId}`);
    expect(rows.map((r) => r.channel).sort()).toEqual(['email', 'sms']);
    const email = rows.find((r) => r.channel === 'email')!;
    expect(email.payload).toMatchObject({ amount: '₹250', amountText: '₹250', firstName: 'Ravi' });
    expect(email.payload['rows']).toContainEqual({ label: 'Reason', value: 'Refund from Circls' });
    // ₹250 of a ₹750 booking: the partial note explains it.
    expect(String(email.payload['partialNote'])).toContain('₹250 of the ₹750');

    const other = await insertBooking('circls', 'Meera');
    await notifyBookingRefunded(other, { amountPaise: 25000, status: 'failed', reason: { kind: 'manual' } });
    expect(await rowsFor('booking.refunded', sql`payload->>'bookingId' = ${other}`)).toHaveLength(0);
  });

  it('notifyBookingCancelled words it by who cancelled, and shows the refund', async () => {
    const bookingId = await insertBooking('circls', 'Kiran');
    await notifyBookingCancelled(bookingId, { mode: 'venue', refundPaise: 75000 });
    const email = (await rowsFor('booking.cancelled', sql`payload->>'bookingId' = ${bookingId}`)).find(
      (r) => r.channel === 'email',
    )!;
    expect(email.payload).toMatchObject({
      eventCancelled: false,
      byCustomer: false,
      orgName: 'Admin Alert Co',
      placeName: 'Alert Arena',
      refundText: '₹750',
    });
  });

  it('a refunded cancellation is one message: the cancellation, with the amount', async () => {
    const bookingId = await insertBooking('circls', 'Nisha');
    await notifyBookingCancelled(bookingId, {
      mode: 'customer',
      refundPaise: 60000,
      refund: { amountPaise: 60000, status: 'processed', reason: { kind: 'cancellation', bySelf: true } },
    });
    const cancelled = await rowsFor('booking.cancelled', sql`payload->>'bookingId' = ${bookingId}`);
    expect(cancelled.map((r) => r.channel).sort()).toEqual(['email', 'sms']);
    expect(cancelled.find((r) => r.channel === 'email')!.payload).toMatchObject({ byCustomer: true, refundText: '₹600' });
    expect(await rowsFor('booking.refunded', sql`payload->>'bookingId' = ${bookingId}`)).toHaveLength(0);
  });

  it('notifyListingSubmitted alerts every admin address with the org, listing and queue', async () => {
    await notifyListingSubmitted('arena', arenaId);
    const rows = await rowsFor('admin.listing_submitted');
    expect(rows.map((r) => r.recipient).sort()).toEqual(['founders@circls.test', 'ops@circls.test']);
    expect(rows[0]!.payload).toMatchObject({
      tenantName: 'Admin Alert Co',
      listingType: 'arena',
      listingTypeLabel: 'Arena',
      listingName: 'Alert Arena — Court A',
    });
    expect(Number(rows[0]!.payload['queueCount'])).toBeGreaterThanOrEqual(1);
    expect(String(rows[0]!.payload['reviewUrl'])).toContain('/listings');
  });

  it('notifyListingReviewed emails the org on approval and on rejection (with the fixes)', async () => {
    await notifyListingReviewed('venue', venueId, 'approved');
    const approved = await rowsFor('listing.approved');
    expect(approved).toHaveLength(1);
    expect(approved[0]!.recipient).toBe('front-desk@circls.test');
    expect(approved[0]!.payload).toMatchObject({
      listingType: 'venue',
      listingName: 'Alert Arena',
      greetingName: 'Admin Alert Co',
    });
    expect(String(approved[0]!.payload['liveUrl'])).toContain(`/venues/${venueId}`);

    await notifyListingReviewed('venue', venueId, 'rejected', '- Photos are missing\n- Add opening hours');
    const rejected = await rowsFor('listing.rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.payload['fixes']).toEqual(['Photos are missing', 'Add opening hours']);
    expect(rejected[0]!.payload['ctaLabel']).toBe('Edit & resubmit');
    expect(String(rejected[0]!.payload['ctaUrl'])).toContain(`/venues/${venueId}`);
  });

  it('an org that switched a kind of email off stops getting it; the customer still does', async () => {
    const profile = await updateTenantProfile(tenantId, { emailPrefs: { booking: false, listing: false } }, ownerUserId);
    expect(profile.emailPrefs).toEqual({ booking: false, listing: false });
    // Only the kinds given change.
    expect((await updateTenantProfile(tenantId, { emailPrefs: { listing: true } }, ownerUserId)).emailPrefs).toEqual({
      booking: false,
      listing: true,
    });
    await updateTenantProfile(tenantId, { emailPrefs: { listing: false } }, ownerUserId);
    // Each real change is in the activity log, with who made it.
    const audits = await db.execute<Record<string, unknown>>(
      sql`select actor_user_id from audit_log where tenant_id = ${tenantId} and action = 'tenant.email_prefs_updated'`,
    );
    expect(audits).toHaveLength(3);
    expect((audits as unknown as Array<Record<string, unknown>>)[0]!['actor_user_id']).toBe(ownerUserId);

    const booking = await insertBooking('circls', 'Quiet Quinn');
    await notifyBookingConfirmed(booking);
    expect(await rowsFor('partner.booking_confirmed', sql`payload->>'bookingId' = ${booking}`)).toHaveLength(0);
    const customerRows = await rowsFor('booking.confirmed', sql`payload->>'bookingId' = ${booking}`);
    expect(customerRows.map((r) => r.channel).sort()).toEqual(['email', 'sms']);

    const before = (await rowsFor('listing.approved')).length;
    await notifyListingReviewed('venue', venueId, 'approved');
    expect(await rowsFor('listing.approved')).toHaveLength(before);

    await updateTenantProfile(tenantId, { emailPrefs: { booking: true, listing: true } }, ownerUserId);
  });

  it('notifyOrgCreated tells the admin team who signed up', async () => {
    await notifyOrgCreated(tenantId);
    const rows = await rowsFor('admin.org_signup');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.payload).toMatchObject({ tenantName: 'Admin Alert Co' });
    const r = rows[0]!.payload['rows'] as Array<{ label: string; value: string }>;
    expect(r).toContainEqual({ label: 'Country', value: 'India' });
    expect(r).toContainEqual({ label: 'Contact', value: 'Olivia Owner' });
    expect(r).toContainEqual({ label: 'Email', value: ownerEmail });
    expect(String(rows[0]!.payload['orgUrl'])).toContain(`/tenants/${tenantId}`);
  });

  it('notifyAdminTeam returns the recipient count and writes one row each', async () => {
    const marker = `digest-${Date.now()}`;
    const sent = await notifyAdminTeam(
      'admin.daily_digest',
      { windowStart: marker, dateLabel: 'Mon, 19 Oct 2026', summary: 'test summary' },
      tenantId,
    );
    expect(sent).toBe(2);
    const rows = await rowsFor('admin.daily_digest', sql`payload->>'windowStart' = ${marker}`);
    expect(rows).toHaveLength(2);
  });
});
