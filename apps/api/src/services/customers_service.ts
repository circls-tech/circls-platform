import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

/**
 * The people an organisation has served before, for the desk forms' autofill.
 *
 * There is no customers table: a customer is whoever shows up on the org's
 * bookings (slot, event and membership rows, consumer and walk-in alike) and
 * on its membership purchases, which a free, coupon-less purchase and a
 * hand-added member reach without a bookings row (see activity_service). A
 * person is the pair (name, contact) — two household members sharing a phone
 * stay two people, and the same person typed twice with different spacing or
 * casing is one.
 *
 * Read-only by design: picking a suggestion only fills the form. The booking
 * or membership that follows is recorded exactly as a hand-typed one would be,
 * so nothing here links records to each other or to a circls account.
 */

export type CustomerKind = 'slot' | 'event' | 'membership';

export interface CustomerSuggestion {
  /** The most recently recorded spelling. */
  name: string;
  /** Phone or email as it was last recorded; null when none was ever captured. */
  contact: string | null;
  /** When they were last booked or added (ISO). */
  lastSeenAt: string;
  /** How many bookings and memberships carry them. */
  timesSeen: number;
  /** Which kinds of thing they have had with the org. */
  kinds: CustomerKind[];
}

export const CUSTOMER_SEARCH_MIN_QUERY = 2;
export const CUSTOMER_SEARCH_DEFAULT_LIMIT = 8;
export const CUSTOMER_SEARCH_MAX_LIMIT = 20;

/** Only the digits of a phone number, however it was typed. */
export function phoneDigits(s: string): string {
  return s.replace(/\D/g, '');
}

/** The country codes circls trades in (India, the US), longest first. */
const COUNTRY_CODES = ['91', '1'];

/**
 * The runs of digits a query is looked for in recorded phone numbers: what was
 * typed, and — so "+91 98765" still finds a number recorded as "98765 43210"
 * — the same with its country code dropped, when the query starts with "+"
 * and one of ours. Only a real country code is dropped: stripping any one to
 * three digits would turn "+91 98765" into "8765", which matches unrelated
 * numbers and crowds the person being looked for off the list. Empty below
 * three digits, where any number matches.
 */
export function phoneQueryVariants(q: string): string[] {
  const digits = phoneDigits(q);
  if (digits.length < 3) return [];
  const out = [digits];
  if (q.trim().startsWith('+')) {
    for (const cc of COUNTRY_CODES) {
      if (!digits.startsWith(cc)) continue;
      const rest = digits.slice(cc.length);
      if (rest.length >= 3 && !out.includes(rest)) out.push(rest);
    }
  }
  return out;
}

/**
 * Customers whose name or contact matches `q`: a substring of the name or the
 * contact as typed, or — so "98765" finds "+91 98765 43210" however it was
 * punctuated — of the contact's digits when the query carries three or more
 * (see phoneQueryVariants). Most recent first.
 */
export async function searchCustomers(
  tenantId: string,
  q: string,
  limit: number = CUSTOMER_SEARCH_DEFAULT_LIMIT,
): Promise<CustomerSuggestion[]> {
  const query = q.trim();
  if (query.length < CUSTOMER_SEARCH_MIN_QUERY) return [];
  const take = Math.max(1, Math.min(limit, CUSTOMER_SEARCH_MAX_LIMIT));

  const like = '%' + escapeLike(query) + '%';
  const digitMatches = phoneQueryVariants(query).map(
    (digits) => sql`contact_digits like ${'%' + digits + '%'}`,
  );
  const byDigits =
    digitMatches.length > 0 ? sql`or (${sql.join(digitMatches, sql` or `)})` : sql``;

  // Postgres must see \D in the two regexes below; the doubled backslash is
  // the template literal's.
  const raw = await db.execute<Record<string, unknown>>(sql`
    with people as (
      select
        coalesce(b.customer_name, u.display_name)             as name,
        coalesce(b.customer_contact, u.phone_e164, u.email)   as contact,
        b.item_type::text                                     as kind,
        b.created_at                                          as seen_at
      from bookings b
      left join users u on u.id = b.customer_user_id
      where b.tenant_id = ${tenantId}
        -- Someone who closed their circls account is gone, along with the
        -- copy of their name and contact the booking kept.
        and (b.customer_user_id is null or u.deleted_at is null)
        -- Only bookings that happened. An online checkout opens as 'pending'
        -- and an abandoned one is swept to 'cancelled' without ever being
        -- paid; neither makes its would-be buyer a customer. A cancelled
        -- booking still counts when it was real: taken at the desk, free, or
        -- paid for.
        and (
          b.status in ('confirmed', 'completed', 'no_show')
          or (
            b.status = 'cancelled'
            and (
              b.payment_method <> 'razorpay_route'
              or exists (
                select 1 from payments p
                where p.booking_id = b.id
                  and p.kind = 'charge'
                  and p.status in ('captured', 'refunded', 'partially_refunded')
              )
            )
          )
        )
      union all
      -- Membership purchases without a bookings row: free ones and members
      -- the partner added by hand. Paid ones are already in from bookings.
      select
        coalesce(um.external_name, u.display_name),
        coalesce(um.external_contact, u.phone_e164, u.email),
        'membership',
        um.created_at
      from user_memberships um
      join memberships m on m.id = um.membership_id
      left join users u on u.id = um.user_id
      where m.tenant_id = ${tenantId}
        and (um.user_id is null or u.deleted_at is null)
        and not exists (
          select 1 from bookings b2
          where b2.tenant_id = ${tenantId}
            and b2.item_type = 'membership'
            and b2.item_data->>'userMembershipId' = um.id::text
        )
    ),
    with_digits as (
      select *, regexp_replace(coalesce(contact, ''), '\\D', '', 'g') as contact_digits
      from people
      where name is not null and btrim(name) <> ''
    ),
    keyed as (
      select
        btrim(name)                                   as name,
        nullif(btrim(contact), '')                    as contact,
        kind,
        seen_at,
        contact_digits,
        lower(btrim(name))                            as name_key,
        -- Emails compare case-insensitively; phones by their digits, keeping
        -- the last ten so "+91 98765 43210" and "9876543210" are one person.
        case
          when contact is null or btrim(contact) = '' then ''
          when contact like '%@%' then lower(btrim(contact))
          else right(contact_digits, 10)
        end                                           as contact_key
      from with_digits
    )
    select
      (array_agg(name order by seen_at desc))[1]      as name,
      (array_agg(contact order by seen_at desc))[1]   as contact,
      max(seen_at)                                    as last_seen_at,
      count(*)::int                                   as times_seen,
      array_agg(distinct kind)                        as kinds
    from keyed
    where (
      name ilike ${like}
      or contact ilike ${like}
      ${byDigits}
    )
    group by name_key, contact_key
    order by last_seen_at desc
    limit ${take}
  `);

  const rows = raw as unknown as Record<string, unknown>[];
  return rows.map((r) => ({
    name: r['name'] as string,
    contact: (r['contact'] as string | null) ?? null,
    lastSeenAt: new Date(r['last_seen_at'] as string).toISOString(),
    timesSeen: Number(r['times_seen']),
    kinds: (r['kinds'] as CustomerKind[]) ?? [],
  }));
}

/** A query is data, never a pattern: its `%` and `_` must match themselves. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}
