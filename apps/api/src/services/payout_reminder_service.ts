/**
 * Payout reminders for the Circls admin team (design: "Payout reminder · Tue /
 * Wed"). Weekly payouts are reconciled Monday morning (payout_service); ops
 * then transfers the money and marks each payout paid. The worker runs this:
 *   - Tuesday 9:00 IST, `heads_up`   — "Payouts go out tomorrow";
 *   - Wednesday 9:00 IST, `payout_day` — "It's payout day", only while
 *     something is still unpaid.
 * Both cover every payout not yet marked paid, so an older unpaid week is
 * never forgotten. Nothing is sent when none is pending.
 */
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import {
  formatDay,
  formatDayMonth,
  formatMoney,
  formatMoneyList,
  plural,
} from '../lib/notifications/email_format.js';
import { notifyAdminTeam } from './notification_service.js';

export const PAYOUT_REMINDER_TEMPLATE_KEY = 'admin.payouts_reminder' as const;

export type PayoutReminderKind = 'heads_up' | 'payout_day';

export interface PayoutReminderResult {
  kind: PayoutReminderKind;
  /** Payouts still waiting for their transfer. */
  pending: number;
  /** Recipients it was sent to (0 when nothing is pending). */
  sent: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const TZ = 'Asia/Kolkata';

type Row = Record<string, unknown>;
const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

interface PendingPayout {
  tenantName: string;
  currency: string;
  amountPaise: number;
  commissionPaise: number;
  periodStart: Date | null;
  periodEnd: Date | null;
  bookings: number;
  firstPayout: boolean;
}

/** Every payout not yet marked paid, with its bookings and whether the org
 *  has ever been paid before. */
async function loadPendingPayouts(): Promise<PendingPayout[]> {
  const rows = (await db.execute<Row>(sql`
    select tn.name            as tenant_name,
           po.currency        as currency,
           po.amount_paise    as amount,
           po.commission_paise as commission,
           po.period_start    as period_start,
           po.period_end      as period_end,
           (select count(distinct pay.booking_id)
              from payments pay
             where pay.tenant_id = po.tenant_id
               and pay.kind = 'charge'
               and pay.settlement_released_at >= po.period_start
               and pay.settlement_released_at <  po.period_end)::int as bookings,
           not exists (select 1 from payouts prev
                        where prev.tenant_id = po.tenant_id and prev.status = 'paid') as first_payout
      from payouts po
      join tenants tn on tn.id = po.tenant_id
     where po.status <> 'paid'
     order by po.amount_paise desc, tn.name asc
  `)) as unknown as Row[];
  return rows.map((r) => ({
    tenantName: String(r['tenant_name'] ?? ''),
    currency: String(r['currency'] ?? 'INR'),
    amountPaise: num(r['amount']),
    commissionPaise: num(r['commission']),
    periodStart: r['period_start'] ? new Date(String(r['period_start'])) : null,
    periodEnd: r['period_end'] ? new Date(String(r['period_end'])) : null,
    bookings: num(r['bookings']),
    firstPayout: r['first_payout'] === true,
  }));
}

function sumByCurrency(items: PendingPayout[], pick: (p: PendingPayout) => number) {
  const acc = new Map<string, number>();
  for (const p of items) acc.set(p.currency, (acc.get(p.currency) ?? 0) + pick(p));
  return [...acc.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, minor]) => ({ currency, minor }));
}

/** The template variables for a reminder (exported for tests). */
export function payoutReminderPayload(
  kind: PayoutReminderKind,
  pending: PendingPayout[],
  now: Date,
): Record<string, unknown> {
  const payoutDay = kind === 'payout_day';
  // Heads-up runs the day before payout day.
  const payoutDate = payoutDay ? now : new Date(now.getTime() + DAY_MS);

  const starts = pending.map((p) => p.periodStart).filter((d): d is Date => d != null);
  const ends = pending.map((p) => p.periodEnd).filter((d): d is Date => d != null);
  const cycle =
    starts.length > 0 && ends.length > 0
      ? // period_end is exclusive: show the last day the cycle covers.
        `${formatDayMonth(new Date(Math.min(...starts.map(Number))), TZ)} – ${formatDayMonth(new Date(Math.max(...ends.map(Number)) - DAY_MS), TZ)}`
      : null;

  const orgCount = new Set(pending.map((p) => p.tenantName)).size;
  const bookingCount = pending.reduce((n, p) => n + p.bookings, 0);
  const totalText = formatMoneyList(sumByCurrency(pending, (p) => p.amountPaise));

  const rows: Array<{ label: string; value: string }> = [];
  if (cycle) rows.push({ label: 'Cycle', value: cycle });
  rows.push(
    { label: 'Organizers', value: String(orgCount) },
    { label: 'Bookings', value: String(bookingCount) },
    { label: 'Platform fees', value: formatMoneyList(sumByCurrency(pending, (p) => p.commissionPaise)) },
  );

  const top = pending.slice(0, 3).map((p) => ({
    name: p.tenantName,
    sub: plural(p.bookings, 'booking'),
    amount: formatMoney(p.amountPaise, p.currency),
    ...(p.firstPayout ? { tag: 'first payout' } : {}),
  }));

  return {
    preheader: payoutDay
      ? 'Approve before noon so transfers clear today.'
      : `Review and approve by end of day. ${plural(orgCount, 'organizer')} this week.`,
    payoutDay,
    payoutDateLabel: formatDay(payoutDate, TZ),
    rows,
    top,
    orgCount,
    totalText,
    payoutsUrl: `${env.ADMIN_BASE_URL.replace(/\/+$/, '')}/payouts`,
  };
}

/** Send the Tuesday or Wednesday reminder, when anything is unpaid. */
export async function sendPayoutReminder(
  kind: PayoutReminderKind,
  now: Date = new Date(),
): Promise<PayoutReminderResult> {
  if (env.ADMIN_TEAM_EMAILS.length === 0) return { kind, pending: 0, sent: 0 };
  const pending = await loadPendingPayouts();
  if (pending.length === 0) return { kind, pending: 0, sent: 0 };
  const sent = await notifyAdminTeam(PAYOUT_REMINDER_TEMPLATE_KEY, payoutReminderPayload(kind, pending, now));
  logger.info({ kind, pending: pending.length, sent }, 'admin_payout_reminder_sent');
  return { kind, pending: pending.length, sent };
}
