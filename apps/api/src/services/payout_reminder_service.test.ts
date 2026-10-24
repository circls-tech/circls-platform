import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { noAutoLink } from '../lib/notifications/email_format.js';

// env.ts is parsed once at import; the admin list must exist before it loads.
vi.hoisted(() => {
  process.env.ADMIN_TEAM_EMAILS = 'ops@circls.test';
});

import { closeDb, db, pingDb } from '../db/client.js';
import { notifications, payouts, tenants } from '../db/schema/index.js';
import { __resetNotificationsForTesting } from '../lib/notifications/index.js';
import { renderEmail } from '../lib/notifications/email_designs/index.js';
import {
  PAYOUT_REMINDER_TEMPLATE_KEY,
  payoutReminderPayload,
  sendPayoutReminder,
} from './payout_reminder_service.js';

const pending = [
  {
    tenantName: 'Bandra Sports Club',
    currency: 'INR',
    amountPaise: 4_260_000,
    commissionPaise: 480_000,
    periodStart: new Date('2026-09-27T18:30:00Z'), // Mon 28 Sep IST
    periodEnd: new Date('2026-10-04T18:30:00Z'), // Mon 5 Oct IST (exclusive)
    bookings: 96,
    firstPayout: false,
  },
  {
    tenantName: 'Clay & Kiln Studio',
    currency: 'INR',
    amountPaise: 2_106_000,
    commissionPaise: 120_000,
    periodStart: new Date('2026-09-27T18:30:00Z'),
    periodEnd: new Date('2026-10-04T18:30:00Z'),
    bookings: 18,
    firstPayout: true,
  },
];
// Tue 6 Oct 2026, 09:00 IST.
const tuesday = new Date('2026-10-06T03:30:00Z');

describe('payoutReminderPayload (pure)', () => {
  it('builds the Tuesday heads-up for tomorrow', () => {
    const p = payoutReminderPayload('heads_up', pending, tuesday);
    expect(p).toMatchObject({
      payoutDay: false,
      payoutDateLabel: 'Wed 7 Oct',
      orgCount: 2,
      totalText: '₹63,660',
      rows: [
        { label: 'Cycle', value: noAutoLink('28 Sep – 4 Oct') },
        { label: 'Organizers', value: '2' },
        { label: 'Bookings', value: '114' },
        { label: 'Platform fees', value: '₹6,000' },
      ],
      top: [
        { name: 'Bandra Sports Club', sub: '96 bookings', amount: '₹42,600' },
        { name: 'Clay & Kiln Studio', sub: '18 bookings', amount: '₹21,060', tag: 'first payout' },
      ],
    });
    const out = renderEmail(PAYOUT_REMINDER_TEMPLATE_KEY, p);
    expect(out.subject).toBe('[Payouts] Due tomorrow — ₹63,660 across 2 organizers');
    expect(out.html).toContain('Payouts go out tomorrow.');
    expect(out.html).toContain('Clay &amp; Kiln Studio');
    expect(out.html).toContain('first payout');
  });

  it('builds the Wednesday payout-day version', () => {
    const p = payoutReminderPayload('payout_day', pending, new Date('2026-10-07T03:30:00Z'));
    expect(p['payoutDateLabel']).toBe('Wed 7 Oct');
    const out = renderEmail(PAYOUT_REMINDER_TEMPLATE_KEY, p);
    expect(out.subject).toBe('[Payouts] Today — ₹63,660 still awaiting approval');
    expect(out.html).toContain('It’s payout day.');
  });
});

const runIntegration = Boolean(process.env.RUN_INTEGRATION);

describe.skipIf(!runIntegration)('sendPayoutReminder (integration)', () => {
  let tenantId: string;

  beforeAll(async () => {
    await pingDb();
    __resetNotificationsForTesting();
    const [t] = await db
      .insert(tenants)
      .values({ name: 'Payout Reminder Co', slug: `payout-reminder-${Date.now()}` })
      .returning();
    tenantId = t!.id;
  });

  afterAll(async () => {
    await db.execute(sql`delete from notifications where template_key = ${PAYOUT_REMINDER_TEMPLATE_KEY}`);
    await db.execute(sql`delete from payouts where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
    await closeDb();
  });

  it('emails the admin team about unpaid payouts and skips once all are paid', async () => {
    const [p] = await db
      .insert(payouts)
      .values({
        tenantId,
        provider: 'external',
        periodStart: new Date('2026-10-05T00:00:00Z'),
        periodEnd: new Date('2026-10-12T00:00:00Z'),
        amountPaise: 1_234_500,
        currency: 'INR',
        status: 'pending',
      })
      .returning();

    const r = await sendPayoutReminder('heads_up', tuesday);
    expect(r.pending).toBeGreaterThanOrEqual(1);
    expect(r.sent).toBe(1);
    const rows = await db
      .select()
      .from(notifications)
      .where(sql`template_key = ${PAYOUT_REMINDER_TEMPLATE_KEY}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.recipient).toBe('ops@circls.test');
    expect(JSON.stringify(rows[0]!.payload['top'])).toContain('Payout Reminder Co');

    await db.update(payouts).set({ status: 'paid' }).where(sql`id = ${p!.id}`);
    const again = await sendPayoutReminder('payout_day');
    // Other unpaid payouts may exist in a shared DB; ours no longer counts.
    if (again.pending === 0) expect(again.sent).toBe(0);
  });
});
