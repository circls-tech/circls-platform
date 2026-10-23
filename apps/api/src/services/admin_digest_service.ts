/**
 * Daily summary for the Circls admin team.
 *
 * The worker runs `sendAdminDailyDigest` every morning (08:00 IST). It totals
 * the previous IST calendar day — bookings, money, sign-ups, what is waiting
 * for review, what failed — renders one plain-text summary and emails it to
 * every address in ADMIN_TEAM_EMAILS through the `admin.daily_digest`
 * template (internal sender — Resend; see lib/notifications/email.ts).
 *
 * Idempotent per window: the digest's `windowStart` is kept in the
 * notification payload, and a window that already has a row is not sent
 * again, so a restart replaying the cron tick cannot double-send.
 *
 * IST is fixed at UTC+5:30 with no DST, so the day boundary is plain
 * arithmetic; this stays in step with the IST timestamps the customer
 * notifications already use.
 */
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { notifyAdminTeam } from './notification_service.js';

export const DIGEST_TEMPLATE_KEY = 'admin.daily_digest' as const;

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface DigestWindow {
  /** Inclusive, 00:00 IST of the summarised day. */
  start: Date;
  /** Exclusive, 00:00 IST of the following day. */
  end: Date;
  /** e.g. "Sun, 19 Oct 2026" — the summarised day. */
  dateLabel: string;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Mon, 19 Oct 2026" for an instant, in IST. Hand-built: Intl's punctuation
 *  for this shape differs between ICU builds, and the label is in a subject. */
function istDateLabel(at: Date): string {
  const d = new Date(at.getTime() + IST_OFFSET_MS);
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${WEEKDAYS[d.getUTCDay()]}, ${day} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** The most recently completed IST calendar day as of `now`. */
export function digestWindow(now: Date = new Date()): DigestWindow {
  const shifted = new Date(now.getTime() + IST_OFFSET_MS);
  const todayStartIst =
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - IST_OFFSET_MS;
  const end = new Date(todayStartIst);
  const start = new Date(todayStartIst - DAY_MS);
  return { start, end, dateLabel: istDateLabel(start) };
}

// ── Stats ─────────────────────────────────────────────────────────────────────

export interface MoneyByCurrency {
  currency: string;
  /** Minor units (paise / cents). */
  minor: number;
}

export interface DigestStats {
  window: DigestWindow;
  bookings: {
    total: number;
    byItemType: Record<string, number>;
    byStatus: Record<string, number>;
    /** Value of bookings created in the window that are confirmed/completed. */
    confirmedValue: MoneyByCurrency[];
    /** Bookings that moved to `cancelled` during the window (any creation date). */
    cancelledInWindow: number;
  };
  payments: {
    capturedCharges: number;
    capturedValue: MoneyByCurrency[];
    refunds: number;
    refundedValue: MoneyByCurrency[];
    failedCharges: number;
  };
  growth: {
    newCustomers: number;
    newOrganisations: number;
  };
  pendingReview: { venues: number; arenas: number; events: number; memberships: number };
  /** Reconciled payouts still waiting for their bank transfer (any age). */
  payoutsPending: { count: number; value: MoneyByCurrency[] };
  failedNotifications: number;
  topVenues: Array<{ name: string; bookings: number }>;
}

type Row = Record<string, unknown>;

function num(v: unknown): number {
  // Postgres returns bigint/sum() as strings through the driver.
  const n = typeof v === 'number' ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function addMoney(acc: Map<string, number>, currency: string, minor: number): void {
  acc.set(currency, (acc.get(currency) ?? 0) + minor);
}

function moneyList(acc: Map<string, number>): MoneyByCurrency[] {
  return [...acc.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, minor]) => ({ currency, minor }));
}

export async function collectDigestStats(window: DigestWindow): Promise<DigestStats> {
  const start = window.start.toISOString();
  const end = window.end.toISOString();

  const bookingRows = (await db.execute<Row>(sql`
    select item_type, status, currency,
           count(*)::int                    as n,
           coalesce(sum(total_paise), 0)    as total
      from bookings
     where created_at >= ${start}::timestamptz
       and created_at <  ${end}::timestamptz
     group by item_type, status, currency
  `)) as unknown as Row[];

  const byItemType: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  const confirmedValue = new Map<string, number>();
  let total = 0;
  for (const r of bookingRows) {
    const n = num(r['n']);
    const itemType = String(r['item_type']);
    const status = String(r['status']);
    total += n;
    byItemType[itemType] = (byItemType[itemType] ?? 0) + n;
    byStatus[status] = (byStatus[status] ?? 0) + n;
    if (status === 'confirmed' || status === 'completed') {
      addMoney(confirmedValue, String(r['currency']), num(r['total']));
    }
  }

  const [cancelledRow] = (await db.execute<Row>(sql`
    select count(*)::int as n
      from bookings
     where status = 'cancelled'
       and updated_at >= ${start}::timestamptz
       and updated_at <  ${end}::timestamptz
  `)) as unknown as Row[];

  const paymentRows = (await db.execute<Row>(sql`
    select kind, status, currency,
           count(*)::int                     as n,
           coalesce(sum(amount_paise), 0)    as total
      from payments
     where created_at >= ${start}::timestamptz
       and created_at <  ${end}::timestamptz
     group by kind, status, currency
  `)) as unknown as Row[];

  let capturedCharges = 0;
  let refunds = 0;
  let failedCharges = 0;
  const capturedValue = new Map<string, number>();
  const refundedValue = new Map<string, number>();
  for (const r of paymentRows) {
    const kind = String(r['kind']);
    const status = String(r['status']);
    const n = num(r['n']);
    const currency = String(r['currency']);
    if (kind === 'charge') {
      if (status === 'captured' || status === 'refunded' || status === 'partially_refunded') {
        capturedCharges += n;
        addMoney(capturedValue, currency, num(r['total']));
      } else if (status === 'failed') {
        failedCharges += n;
      }
    } else if (kind === 'refund') {
      refunds += n;
      // Refund rows carry a negative amount; report the money that went back.
      addMoney(refundedValue, currency, Math.abs(num(r['total'])));
    }
  }

  const [growthRow] = (await db.execute<Row>(sql`
    select (select count(*)::int from users
             where created_at >= ${start}::timestamptz
               and created_at <  ${end}::timestamptz
               and deleted_at is null)                        as customers,
           (select count(*)::int from tenants
             where created_at >= ${start}::timestamptz
               and created_at <  ${end}::timestamptz
               and is_platform = false)                       as organisations
  `)) as unknown as Row[];

  const [reviewRow] = (await db.execute<Row>(sql`
    select (select count(*)::int from venues      where status = 'pending_review') as venues,
           (select count(*)::int from arenas      where status = 'pending_review') as arenas,
           (select count(*)::int from events      where status = 'pending_review') as events,
           (select count(*)::int from memberships where status = 'pending_review') as memberships
  `)) as unknown as Row[];

  const payoutRows = (await db.execute<Row>(sql`
    select currency, count(*)::int as n, coalesce(sum(amount_paise), 0) as total
      from payouts
     where status <> 'paid'
     group by currency
  `)) as unknown as Row[];
  const payoutsValue = new Map<string, number>();
  let payoutsCount = 0;
  for (const r of payoutRows) {
    payoutsCount += num(r['n']);
    addMoney(payoutsValue, String(r['currency']), num(r['total']));
  }

  const [failedNotifRow] = (await db.execute<Row>(sql`
    select count(*)::int as n
      from notifications
     where status = 'failed'
       and created_at >= ${start}::timestamptz
       and created_at <  ${end}::timestamptz
  `)) as unknown as Row[];

  const topVenueRows = (await db.execute<Row>(sql`
    select v.name as name, count(*)::int as n
      from bookings b
      join venues v on v.id = b.venue_id
     where b.created_at >= ${start}::timestamptz
       and b.created_at <  ${end}::timestamptz
       and b.status <> 'cancelled'
     group by v.name
     order by n desc, v.name asc
     limit 5
  `)) as unknown as Row[];

  return {
    window,
    bookings: {
      total,
      byItemType,
      byStatus,
      confirmedValue: moneyList(confirmedValue),
      cancelledInWindow: num(cancelledRow?.['n']),
    },
    payments: {
      capturedCharges,
      capturedValue: moneyList(capturedValue),
      refunds,
      refundedValue: moneyList(refundedValue),
      failedCharges,
    },
    growth: {
      newCustomers: num(growthRow?.['customers']),
      newOrganisations: num(growthRow?.['organisations']),
    },
    pendingReview: {
      venues: num(reviewRow?.['venues']),
      arenas: num(reviewRow?.['arenas']),
      events: num(reviewRow?.['events']),
      memberships: num(reviewRow?.['memberships']),
    },
    payoutsPending: { count: payoutsCount, value: moneyList(payoutsValue) },
    failedNotifications: num(failedNotifRow?.['n']),
    topVenues: topVenueRows.map((r) => ({ name: String(r['name']), bookings: num(r['n']) })),
  };
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function formatMoney(list: MoneyByCurrency[]): string {
  if (list.length === 0) return '—';
  return list
    .map(
      ({ currency, minor }) =>
        `${currency} ${(minor / 100).toLocaleString('en-IN', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}`,
    )
    .join(' · ');
}

function formatCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return '—';
  return entries.map(([k, v]) => `${k} ${v}`).join(' · ');
}

const TIME_FMT = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** The email body — plain text, one screen, scannable on a phone. */
export function renderDigest(stats: DigestStats): string {
  const { window: w, bookings, payments, growth, pendingReview, topVenues } = stats;
  const lines: string[] = [];
  lines.push(`Circls daily summary — ${w.dateLabel} (IST)`);
  lines.push(`Window: ${TIME_FMT.format(w.start)} – ${TIME_FMT.format(w.end)} IST`);
  lines.push('');
  lines.push('Bookings');
  lines.push(`  New bookings: ${bookings.total} (${formatCounts(bookings.byItemType)})`);
  lines.push(`  By status: ${formatCounts(bookings.byStatus)}`);
  lines.push(`  Confirmed value: ${formatMoney(bookings.confirmedValue)}`);
  lines.push(`  Cancellations during the day: ${bookings.cancelledInWindow}`);
  lines.push('');
  lines.push('Payments');
  lines.push(`  Captured charges: ${payments.capturedCharges} · ${formatMoney(payments.capturedValue)}`);
  lines.push(`  Refunds: ${payments.refunds} · ${formatMoney(payments.refundedValue)}`);
  lines.push(`  Failed charges: ${payments.failedCharges}`);
  lines.push('');
  lines.push('Growth');
  lines.push(`  New customer accounts: ${growth.newCustomers}`);
  lines.push(`  New partner organisations: ${growth.newOrganisations}`);
  lines.push('');
  lines.push(
    `Awaiting review: venues ${pendingReview.venues} · arenas ${pendingReview.arenas} · ` +
      `events ${pendingReview.events} · memberships ${pendingReview.memberships}`,
  );
  lines.push(
    `Payouts awaiting transfer: ${stats.payoutsPending.count}` +
      (stats.payoutsPending.count > 0 ? ` · ${formatMoney(stats.payoutsPending.value)}` : ''),
  );
  lines.push(`Failed notifications: ${stats.failedNotifications}`);
  lines.push('');
  lines.push('Top venues (bookings made during the day)');
  if (topVenues.length === 0) {
    lines.push('  —');
  } else {
    topVenues.forEach((v, i) => lines.push(`  ${i + 1}. ${v.name} — ${v.bookings}`));
  }
  lines.push('');
  lines.push('— Circls');
  return lines.join('\n');
}

// ── Entry point ───────────────────────────────────────────────────────────────

export interface DigestRunResult {
  windowStart: string;
  /** Recipients the digest was dispatched to. */
  sent: number;
  /** Why nothing was sent, when nothing was. */
  skipped?: 'no_recipients' | 'already_sent';
}

/**
 * Build and send the digest for the IST day that ended most recently before
 * `now`. Returns what happened; never throws past a logged warning, since the
 * worker treats this as best-effort housekeeping.
 */
export async function sendAdminDailyDigest(now: Date = new Date()): Promise<DigestRunResult> {
  const window = digestWindow(now);
  const windowStart = window.start.toISOString();

  if (env.ADMIN_TEAM_EMAILS.length === 0) {
    return { windowStart, sent: 0, skipped: 'no_recipients' };
  }

  const [existing] = (await db.execute<Row>(sql`
    select 1 as one
      from notifications
     where template_key = ${DIGEST_TEMPLATE_KEY}
       and payload->>'windowStart' = ${windowStart}
     limit 1
  `)) as unknown as Row[];
  if (existing) {
    return { windowStart, sent: 0, skipped: 'already_sent' };
  }

  const stats = await collectDigestStats(window);
  const summary = renderDigest(stats);
  const sent = await notifyAdminTeam(DIGEST_TEMPLATE_KEY, {
    windowStart,
    dateLabel: window.dateLabel,
    summary,
  });
  logger.info({ windowStart, sent, bookings: stats.bookings.total }, 'admin_daily_digest_sent');
  return { windowStart, sent };
}
