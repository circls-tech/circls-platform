/**
 * QR ticket service.
 *
 * Issuance: when a purchase is finalised we mint `qr_tickets` rows for listings
 * whose `qr_ticket_config.enabled` is true. The rules (single/multi-use, scan
 * cap) and the concrete validity window are frozen onto each row at issuance —
 * later config edits never mutate already-sold tickets.
 *
 *   - event bookings   → one ticket per seat, window from the event's start/end
 *   - slot bookings    → one ticket per arena in the booking, window from that
 *                        arena's booked-slot span
 *   - membership buys  → one ticket per user_membership, window from the
 *                        membership period
 *
 * Callers: `onBookingConfirmed` (free/inline confirms), the payment-captured
 * webhook (paid confirms, inside its tx), and `purchaseMembership` (free path,
 * which has no bookings row). All issuance is idempotent per subject, so a
 * webhook replay or a double hook never double-mints.
 *
 * Validation is an online check-and-consume: the QR encodes a partner-portal
 * check-in URL carrying the opaque `code`; the endpoint looks the row up FOR
 * UPDATE, applies window/usage rules, and (by default) consumes a scan.
 */
import { randomBytes } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { env } from '../config/env.js';
import { bookings, type Booking } from '../db/schema/bookings.js';
import { events } from '../db/schema/events.js';
import { memberships, userMemberships } from '../db/schema/memberships.js';
import { membershipTiers } from '../db/schema/membership_tiers.js';
import { payments } from '../db/schema/payments.js';
import { qrTickets, type NewQrTicket, type QrTicket } from '../db/schema/qr_tickets.js';
import type { QrTicketConfig } from '../db/schema/qr_ticket_config.js';
import { type AuditCtx, writeAudit } from '../lib/audit.js';
import { logger } from '../lib/logger.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Database = typeof db | Tx;

/** The string the consumer app encodes into the QR image: a partner-portal
 *  check-in URL, so any phone camera deep-links door staff straight into
 *  validation (manual code entry remains the fallback). */
export function qrTicketDataUrl(code: string): string {
  return `${env.PARTNERS_BASE_URL}/check-in?code=${encodeURIComponent(code)}`;
}

function newCode(): string {
  return randomBytes(16).toString('base64url');
}

/** Concrete validity instants from the config's offsets + the item's window. */
function computeWindow(
  cfg: QrTicketConfig,
  startsAt: Date | null,
  endsAt: Date | null,
): { validFrom: Date | null; validUntil: Date | null } {
  const validFrom =
    cfg.validFromOffsetMin != null && startsAt
      ? new Date(startsAt.getTime() - cfg.validFromOffsetMin * 60_000)
      : null; // null = valid as soon as issued
  const validUntil = endsAt
    ? new Date(endsAt.getTime() + (cfg.validUntilOffsetMin ?? 0) * 60_000)
    : null;
  return { validFrom, validUntil };
}

function ticketValues(
  cfg: QrTicketConfig,
  base: Pick<NewQrTicket, 'tenantId' | 'bookingId' | 'userMembershipId' | 'itemType' | 'label'>,
  startsAt: Date | null,
  endsAt: Date | null,
): NewQrTicket {
  return {
    ...base,
    code: newCode(),
    ...computeWindow(cfg, startsAt, endsAt),
    multiUse: cfg.multiUse,
    maxScans: cfg.multiUse ? cfg.maxScans : null,
  };
}

/**
 * Mint QR tickets for a confirmed booking (idempotent: an existing ticket for
 * the booking short-circuits, so webhook replays and double hooks are safe).
 * Pass the surrounding tx when calling from inside one (the payment-captured
 * handler confirms the booking in its own tx; a plain `db` read there would
 * not see the uncommitted row).
 *
 * A booking can legitimately own several ticket rows (one per seat / per
 * arena), so idempotency can't be a DB-level unique constraint on booking_id.
 * Instead we lock the booking row for the whole check-then-insert below —
 * same FOR UPDATE pattern as refund_service's double-refund guard — so two
 * concurrent calls for the same booking (a client-retried confirm, a webhook
 * replay racing the inline path) can't both pass the "no tickets yet" check.
 * When called with the default `db` (no surrounding tx) we open one here so
 * the lock is actually held across the check and the insert.
 */
export async function issueQrTicketsForBooking(
  bookingId: string,
  dbx: Database = db,
): Promise<QrTicket[]> {
  if (dbx === db) {
    return db.transaction((tx) => issueQrTicketsForBookingLocked(bookingId, tx));
  }
  return issueQrTicketsForBookingLocked(bookingId, dbx);
}

async function issueQrTicketsForBookingLocked(
  bookingId: string,
  dbx: Database,
): Promise<QrTicket[]> {
  const [booking] = await dbx
    .select()
    .from(bookings)
    .where(eq(bookings.id, bookingId))
    .limit(1)
    .for('update');
  if (!booking || booking.status !== 'confirmed') return [];

  const existing = await dbx.select().from(qrTickets).where(eq(qrTickets.bookingId, bookingId));
  if (existing.length > 0) return existing;

  switch (booking.itemType) {
    case 'slot':
      return issueForSlotBooking(booking, dbx);
    case 'event':
      return issueForEventBooking(booking, dbx);
    case 'membership': {
      const umId = await resolveUserMembershipId(booking, dbx);
      if (!umId) {
        logger.warn({ bookingId }, 'qr_ticket_membership_booking_without_user_membership');
        return [];
      }
      return issueQrTicketsForUserMembership(umId, { bookingId }, dbx);
    }
    default:
      return [];
  }
}

/** One ticket per arena in the booking, valid over that arena's booked span. */
async function issueForSlotBooking(booking: Booking, dbx: Database): Promise<QrTicket[]> {
  const raw = await dbx.execute<Record<string, unknown>>(sql`
    select a.id                       as arena_id,
           a.name                     as arena_name,
           a.qr_ticket_config         as cfg,
           min(lower(s.time_range))   as start_at,
           max(upper(s.time_range))   as end_at
    from slots s
    join arenas a on a.id = s.arena_id
    where s.booking_id = ${booking.id}
      and s.deleted_at is null
    group by a.id, a.name, a.qr_ticket_config
  `);
  const groups = raw as unknown as Record<string, unknown>[];

  const values: NewQrTicket[] = [];
  for (const g of groups) {
    const cfg = g['cfg'] as QrTicketConfig | null;
    if (!cfg?.enabled) continue;
    values.push(
      ticketValues(
        cfg,
        {
          tenantId: booking.tenantId,
          bookingId: booking.id,
          userMembershipId: null,
          itemType: 'slot',
          label: g['arena_name'] as string,
        },
        new Date(g['start_at'] as string),
        new Date(g['end_at'] as string),
      ),
    );
  }
  if (values.length === 0) return [];
  return dbx.insert(qrTickets).values(values).returning();
}

/** One ticket per seat: a line of quantity 3 mints 3 individually-scannable QRs. */
async function issueForEventBooking(booking: Booking, dbx: Database): Promise<QrTicket[]> {
  const eventId = (booking.itemData?.['eventId'] as string | undefined) ?? null;
  if (!eventId) return [];
  const [ev] = await dbx.select().from(events).where(eq(events.id, eventId)).limit(1);
  const cfg = ev?.qrTicketConfig;
  if (!ev || !cfg?.enabled) return [];

  const raw = await dbx.execute<Record<string, unknown>>(sql`
    select ebt.quantity as quantity, t.name as tier_name
    from event_booking_tickets ebt
    join event_ticket_tiers t on t.id = ebt.tier_id
    where ebt.booking_id = ${booking.id}
    order by t.sort_order, t.name
  `);
  const lines = raw as unknown as Record<string, unknown>[];

  const values: NewQrTicket[] = [];
  for (const line of lines) {
    const quantity = Number(line['quantity']);
    const tierName = line['tier_name'] as string;
    for (let i = 1; i <= quantity; i++) {
      values.push(
        ticketValues(
          cfg,
          {
            tenantId: booking.tenantId,
            bookingId: booking.id,
            userMembershipId: null,
            itemType: 'event',
            label: quantity > 1 ? `${tierName} · ${i} of ${quantity}` : tierName,
          },
          ev.startsAt,
          ev.endsAt,
        ),
      );
    }
  }
  if (values.length === 0) return [];
  return dbx.insert(qrTickets).values(values).returning();
}

/**
 * Find the user_membership a membership booking paid for. Newer bookings carry
 * it in item_data; older paid ones are reachable via the stitched payment row.
 */
async function resolveUserMembershipId(booking: Booking, dbx: Database): Promise<string | null> {
  const direct = (booking.itemData?.['userMembershipId'] as string | undefined) ?? null;
  if (direct) return direct;
  const [byPayment] = await dbx
    .select({ id: userMemberships.id })
    .from(userMemberships)
    .innerJoin(payments, eq(payments.id, userMemberships.paymentId))
    .where(eq(payments.bookingId, booking.id))
    .limit(1);
  return byPayment?.id ?? null;
}

/**
 * Mint the QR ticket for a membership purchase (idempotent per
 * user_membership). Used directly by the free-purchase path (no bookings row)
 * and via `issueQrTicketsForBooking` for paid ones.
 *
 * Unlike bookings, a user_membership owns at most one ticket, so this is
 * additionally backed by a DB-level partial unique index (see migration
 * 0031) — but we still lock the row for the check-then-insert so a race
 * fails closed as a safe no-op read instead of a thrown unique-violation.
 */
export async function issueQrTicketsForUserMembership(
  userMembershipId: string,
  opts: { bookingId?: string | null } = {},
  dbx: Database = db,
): Promise<QrTicket[]> {
  if (dbx === db) {
    return db.transaction((tx) => issueQrTicketsForUserMembershipLocked(userMembershipId, opts, tx));
  }
  return issueQrTicketsForUserMembershipLocked(userMembershipId, opts, dbx);
}

async function issueQrTicketsForUserMembershipLocked(
  userMembershipId: string,
  opts: { bookingId?: string | null },
  dbx: Database,
): Promise<QrTicket[]> {
  await dbx
    .select({ id: userMemberships.id })
    .from(userMemberships)
    .where(eq(userMemberships.id, userMembershipId))
    .limit(1)
    .for('update');

  const existing = await dbx
    .select()
    .from(qrTickets)
    .where(eq(qrTickets.userMembershipId, userMembershipId));
  if (existing.length > 0) return existing;

  const [row] = await dbx
    .select({ um: userMemberships, m: memberships, tierName: membershipTiers.name })
    .from(userMemberships)
    .innerJoin(memberships, eq(memberships.id, userMemberships.membershipId))
    .leftJoin(membershipTiers, eq(membershipTiers.id, userMemberships.membershipTierId))
    .where(eq(userMemberships.id, userMembershipId))
    .limit(1);
  if (!row) return [];
  const cfg = row.m.qrTicketConfig;
  if (!cfg?.enabled || row.um.status !== 'active') return [];

  return dbx
    .insert(qrTickets)
    .values(
      ticketValues(
        cfg,
        {
          tenantId: row.m.tenantId,
          bookingId: opts.bookingId ?? null,
          userMembershipId,
          itemType: 'membership',
          label: row.tierName ? `${row.m.name} — ${row.tierName}` : row.m.name,
        },
        row.um.startsAt,
        row.um.endsAt,
      ),
    )
    .returning();
}

/** Revoke any still-active tickets of a cancelled booking. */
export async function revokeQrTicketsForBooking(
  bookingId: string,
  dbx: Database = db,
): Promise<void> {
  await dbx
    .update(qrTickets)
    .set({ status: 'revoked' })
    .where(and(eq(qrTickets.bookingId, bookingId), eq(qrTickets.status, 'active')));
}

/** Revoke any still-active tickets issued for a cancelled event's bookings. */
export async function revokeQrTicketsForEvent(eventId: string, dbx: Database = db): Promise<void> {
  const eventBookings = await dbx
    .select({ id: bookings.id })
    .from(bookings)
    .where(and(eq(bookings.itemType, 'event'), sql`${bookings.itemData}->>'eventId' = ${eventId}`));
  const bookingIds = eventBookings.map((b) => b.id);
  if (bookingIds.length === 0) return;

  await dbx
    .update(qrTickets)
    .set({ status: 'revoked' })
    .where(and(inArray(qrTickets.bookingId, bookingIds), eq(qrTickets.status, 'active')));
}

// ── Validation (door scan) ───────────────────────────────────────────────────

export type QrScanOutcome =
  | 'valid'
  | 'not_found'
  | 'revoked'
  | 'expired'
  | 'not_yet_valid'
  | 'already_used';

/** What door staff sees after a scan — enough to admit or turn away. */
export interface QrScanTicket {
  id: string;
  itemType: string;
  label: string | null;
  bookingId: string | null;
  customerName: string | null;
  validFrom: string | null;
  validUntil: string | null;
  multiUse: boolean;
  maxScans: number | null;
  scanCount: number;
  firstScannedAt: string | null;
  lastScannedAt: string | null;
  status: string;
}

export interface QrScanResult {
  outcome: QrScanOutcome;
  ticket: QrScanTicket | null;
}

/**
 * Atomic check-and-consume of a scanned code, tenant-scoped (a code from
 * another tenant reads as not_found — no cross-tenant probing). `consume:false`
 * peeks without spending a scan. Single-use tickets flip to `used` on their
 * first valid scan; capped multi-use ones when the cap is reached.
 */
export async function validateQrTicket(
  ctx: AuditCtx,
  code: string,
  opts: { consume?: boolean } = {},
): Promise<QrScanResult> {
  const consume = opts.consume ?? true;

  return db.transaction(async (tx) => {
    const [t] = await tx.select().from(qrTickets).where(eq(qrTickets.code, code)).for('update');
    if (!t || t.tenantId !== ctx.tenantId) return { outcome: 'not_found', ticket: null };

    const now = new Date();
    let outcome: QrScanOutcome = 'valid';
    if (t.status === 'revoked') outcome = 'revoked';
    else if (t.status === 'used') outcome = 'already_used';
    else if (t.validFrom && now < t.validFrom) outcome = 'not_yet_valid';
    else if (t.validUntil && now > t.validUntil) outcome = 'expired';
    else if (t.multiUse && t.maxScans != null && t.scanCount >= t.maxScans)
      outcome = 'already_used';

    let updated = t;
    if (outcome === 'valid' && consume) {
      const nextCount = t.scanCount + 1;
      const exhausted = !t.multiUse || (t.maxScans != null && nextCount >= t.maxScans);
      const [u] = await tx
        .update(qrTickets)
        .set({
          scanCount: nextCount,
          firstScannedAt: t.firstScannedAt ?? now,
          lastScannedAt: now,
          status: exhausted ? 'used' : 'active',
        })
        .where(eq(qrTickets.id, t.id))
        .returning();
      updated = u ?? t;

      await writeAudit(tx, ctx, 'qr_ticket.scanned', 'qr_ticket', t.id, null, {
        outcome,
        scanCount: nextCount,
        bookingId: t.bookingId,
      });
    }

    // Who the ticket belongs to, for the door-staff card.
    let customerName: string | null = null;
    if (t.bookingId) {
      const [b] = await tx
        .select({ customerName: bookings.customerName })
        .from(bookings)
        .where(eq(bookings.id, t.bookingId))
        .limit(1);
      customerName = b?.customerName ?? null;
    }
    if (!customerName && t.userMembershipId) {
      const raw = await tx.execute<Record<string, unknown>>(sql`
        select u.display_name as display_name
        from user_memberships um
        join users u on u.id = um.user_id
        where um.id = ${t.userMembershipId}
        limit 1
      `);
      const rows = raw as unknown as Record<string, unknown>[];
      customerName = (rows[0]?.['display_name'] as string | null) ?? null;
    }

    return {
      outcome,
      ticket: {
        id: updated.id,
        itemType: updated.itemType,
        label: updated.label,
        bookingId: updated.bookingId,
        customerName,
        validFrom: updated.validFrom?.toISOString() ?? null,
        validUntil: updated.validUntil?.toISOString() ?? null,
        multiUse: updated.multiUse,
        maxScans: updated.maxScans,
        scanCount: updated.scanCount,
        firstScannedAt: updated.firstScannedAt?.toISOString() ?? null,
        lastScannedAt: updated.lastScannedAt?.toISOString() ?? null,
        status: updated.status,
      },
    };
  });
}
