import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// See notification_service.admin.test.ts — the list must exist before env.ts
// is first imported. The unit tests below don't need it; the integration
// block does.
vi.hoisted(() => {
  process.env.ADMIN_TEAM_EMAILS = 'ops@circls.test';
});

import { closeDb, db, pingDb } from '../db/client.js';
import { bookings, notifications, tenants, venues } from '../db/schema/index.js';
import { __resetNotificationsForTesting } from '../lib/notifications/index.js';
import {
  DIGEST_TEMPLATE_KEY,
  collectDigestStats,
  digestWindow,
  renderDigest,
  sendAdminDailyDigest,
  type DigestStats,
} from './admin_digest_service.js';

describe('digestWindow (pure)', () => {
  it('covers the IST calendar day that ended most recently', () => {
    // 2026-10-20 02:30 UTC = 08:00 IST on the 20th → summarise the 19th IST.
    const w = digestWindow(new Date('2026-10-20T02:30:00Z'));
    expect(w.start.toISOString()).toBe('2026-10-18T18:30:00.000Z'); // 19 Oct 00:00 IST
    expect(w.end.toISOString()).toBe('2026-10-19T18:30:00.000Z'); // 20 Oct 00:00 IST
    expect(w.dateLabel).toBe('Mon, 19 Oct 2026');
  });

  it('rolls over at IST midnight, not UTC midnight', () => {
    // 2026-10-19 18:00 UTC is still 23:30 IST on the 19th → summarise the 18th.
    const before = digestWindow(new Date('2026-10-19T18:00:00Z'));
    expect(before.dateLabel).toBe('Sun, 18 Oct 2026');
    // 2026-10-19 18:30 UTC is 00:00 IST on the 20th → summarise the 19th.
    const after = digestWindow(new Date('2026-10-19T18:30:00Z'));
    expect(after.dateLabel).toBe('Mon, 19 Oct 2026');
  });
});

describe('renderDigest (pure)', () => {
  it('lays out every section with per-currency money', () => {
    const stats: DigestStats = {
      window: digestWindow(new Date('2026-10-20T02:30:00Z')),
      bookings: {
        total: 12,
        byItemType: { slot: 8, event: 3, membership: 1 },
        byStatus: { confirmed: 10, pending: 1, cancelled: 1 },
        confirmedValue: [
          { currency: 'INR', minor: 2_450_000 },
          { currency: 'USD', minor: 12_000 },
        ],
        cancelledInWindow: 2,
      },
      payments: {
        capturedCharges: 9,
        capturedValue: [{ currency: 'INR', minor: 2_300_000 }],
        refunds: 1,
        refundedValue: [{ currency: 'INR', minor: 50_000 }],
        failedCharges: 1,
      },
      growth: { newCustomers: 7, newOrganisations: 1 },
      pendingReview: { venues: 2, arenas: 1, events: 3, memberships: 0 },
      payoutsPending: { count: 2, value: [{ currency: 'INR', minor: 1_800_000 }] },
      failedNotifications: 0,
      topVenues: [
        { name: 'Tigers Arena', bookings: 5 },
        { name: 'Lions Court', bookings: 3 },
      ],
    };
    const text = renderDigest(stats);
    expect(text).toContain('Circls daily summary — Mon, 19 Oct 2026 (IST)');
    expect(text).toContain('New bookings: 12 (event 3 · membership 1 · slot 8)');
    expect(text).toContain('Confirmed value: INR 24,500.00 · USD 120.00');
    expect(text).toContain('Cancellations during the day: 2');
    expect(text).toContain('Captured charges: 9 · INR 23,000.00');
    expect(text).toContain('Refunds: 1 · INR 500.00');
    expect(text).toContain('New customer accounts: 7');
    expect(text).toContain('Awaiting review: venues 2 · arenas 1 · events 3 · memberships 0');
    expect(text).toContain('Payouts awaiting transfer: 2 · INR 18,000.00');
    expect(text).toContain('1. Tigers Arena — 5');
    expect(text).toContain('2. Lions Court — 3');
  });

  it('shows dashes for an empty day', () => {
    const text = renderDigest({
      window: digestWindow(new Date('2026-10-20T02:30:00Z')),
      bookings: { total: 0, byItemType: {}, byStatus: {}, confirmedValue: [], cancelledInWindow: 0 },
      payments: { capturedCharges: 0, capturedValue: [], refunds: 0, refundedValue: [], failedCharges: 0 },
      growth: { newCustomers: 0, newOrganisations: 0 },
      pendingReview: { venues: 0, arenas: 0, events: 0, memberships: 0 },
      payoutsPending: { count: 0, value: [] },
      failedNotifications: 0,
      topVenues: [],
    });
    expect(text).toContain('New bookings: 0 (—)');
    expect(text).toContain('Payouts awaiting transfer: 0\n');
    expect(text).toContain('Confirmed value: —');
    expect(text).toContain('Top venues (bookings made during the day)\n  —');
  });
});

const runIntegration = Boolean(process.env.RUN_INTEGRATION);

describe.skipIf(!runIntegration)('sendAdminDailyDigest (integration)', () => {
  let tenantId: string;
  let venueId: string;
  const venueName = `Digest Venue ${Date.now()}`;
  // A "now" one day ahead makes the digest window the IST day that contains
  // the rows this test inserts (created_at = now()).
  const fakeNow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const windowStart = digestWindow(fakeNow).start.toISOString();

  beforeAll(async () => {
    await pingDb();
    __resetNotificationsForTesting();
    const [t] = await db
      .insert(tenants)
      .values({ name: 'Digest Co', slug: `digest-${Date.now()}` })
      .returning();
    tenantId = t!.id;
    const [v] = await db
      .insert(venues)
      .values({ tenantId, name: venueName, tzName: 'Asia/Kolkata' })
      .returning();
    venueId = v!.id;
    await db.insert(bookings).values([
      {
        tenantId,
        venueId,
        itemType: 'slot',
        channel: 'circls',
        paymentMethod: 'razorpay_route',
        status: 'confirmed',
        totalPaise: 50000,
        currency: 'INR',
      },
      {
        tenantId,
        venueId,
        itemType: 'event',
        channel: 'circls',
        paymentMethod: 'razorpay_route',
        status: 'confirmed',
        totalPaise: 2000,
        currency: 'USD',
      },
    ]);
  });

  afterAll(async () => {
    await db.execute(sql`delete from notifications where template_key = ${DIGEST_TEMPLATE_KEY} and payload->>'windowStart' = ${windowStart}`);
    await db.execute(sql`delete from notifications where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from bookings where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from venues where id = ${venueId}`);
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
    await closeDb();
  });

  it('counts the day’s bookings per currency and lists the venue', async () => {
    const stats = await collectDigestStats(digestWindow(fakeNow));
    expect(stats.bookings.total).toBeGreaterThanOrEqual(2);
    expect(stats.bookings.byItemType['slot'] ?? 0).toBeGreaterThanOrEqual(1);
    expect(stats.bookings.byItemType['event'] ?? 0).toBeGreaterThanOrEqual(1);
    const inr = stats.bookings.confirmedValue.find((m) => m.currency === 'INR');
    const usd = stats.bookings.confirmedValue.find((m) => m.currency === 'USD');
    expect(inr?.minor ?? 0).toBeGreaterThanOrEqual(50000);
    expect(usd?.minor ?? 0).toBeGreaterThanOrEqual(2000);
    // The shared DB may hold busier venues; ours must at least be counted.
    const mine = stats.topVenues.find((v) => v.name === venueName);
    if (mine) expect(mine.bookings).toBe(2);
  });

  it('sends once per window and skips a repeat run', async () => {
    const first = await sendAdminDailyDigest(fakeNow);
    expect(first).toEqual({ windowStart, sent: 1 });

    const rows = await db
      .select()
      .from(notifications)
      .where(sql`template_key = ${DIGEST_TEMPLATE_KEY} and payload->>'windowStart' = ${windowStart}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.recipient).toBe('ops@circls.test');
    expect(rows[0]!.channel).toBe('email');
    expect(String(rows[0]!.payload['summary'])).toContain('Circls daily summary');

    const second = await sendAdminDailyDigest(fakeNow);
    expect(second).toEqual({ windowStart, sent: 0, skipped: 'already_sent' });
    const again = await db
      .select()
      .from(notifications)
      .where(sql`template_key = ${DIGEST_TEMPLATE_KEY} and payload->>'windowStart' = ${windowStart}`);
    expect(again).toHaveLength(1);
  });
});
