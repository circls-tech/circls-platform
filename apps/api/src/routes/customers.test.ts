import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Customer lookup for the desk forms' autofill: who it finds, how it folds
// one person's repeat visits into one row, and who may ask. Integration-gated.
vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      owner: { uid: 'fbuid_custowner', email: 'custowner@x.com', email_verified: true },
      readonly: { uid: 'fbuid_custreadonly', email: 'custreadonly@x.com', email_verified: true },
      other: { uid: 'fbuid_custother', email: 'custother@x.com', email_verified: true },
    };
    const u = map[token];
    if (!u) throw new Error('bad token');
    return u;
  }),
}));

const { closeDb, db } = await import('../db/client.js');
const { bookings, memberships, tenantMembers, userMemberships, users, venues } = await import(
  '../db/schema/index.js'
);
const { buildServer } = await import('../server.js');
const { phoneDigits, phoneQueryVariants } = await import('../services/customers_service.js');

const runIntegration = Boolean(process.env.RUN_INTEGRATION);
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

interface Suggestion {
  name: string;
  contact: string | null;
  lastSeenAt: string;
  timesSeen: number;
  kinds: string[];
}

describe('phoneDigits', () => {
  it('keeps only the digits', () => {
    expect(phoneDigits('+91 98765-43210')).toBe('919876543210');
    expect(phoneDigits('ravi@example.com')).toBe('');
  });
});

describe('phoneQueryVariants', () => {
  it('looks for the digits as typed', () => {
    expect(phoneQueryVariants('98765 432')).toEqual(['98765432']);
    expect(phoneQueryVariants('919876')).toEqual(['919876']);
  });
  it('also drops a country code the query spells out with a +', () => {
    expect(phoneQueryVariants('+91 98765')).toEqual(['9198765', '198765', '98765', '8765']);
    expect(phoneQueryVariants('+1 555')).toEqual(['1555', '555']);
  });
  it('is empty where any number would match', () => {
    expect(phoneQueryVariants('98')).toEqual([]);
    expect(phoneQueryVariants('ravi')).toEqual([]);
  });
});

describe.skipIf(!runIntegration)('customer lookup', () => {
  let app: FastifyInstance;
  let tenantId: string;
  let otherTenantId: string;

  async function search(q: string, token = 'owner', extra = '') {
    return app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/customers?q=${encodeURIComponent(q)}${extra}`,
      headers: bearer(token),
    });
  }
  async function customers(q: string): Promise<Suggestion[]> {
    const res = await search(q);
    expect(res.statusCode).toBe(200);
    return (res.json() as { customers: Suggestion[] }).customers;
  }

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();

    const mkTenant = async (name: string) => {
      const t = await app.inject({
        method: 'POST',
        url: '/v1/tenants',
        headers: bearer('owner'),
        payload: { name, slug: `${name.toLowerCase()}-${Date.now()}`, country: 'India', acceptTerms: true },
      });
      expect(t.statusCode).toBe(200);
      return t.json().id as string;
    };
    tenantId = await mkTenant('CustCo');
    otherTenantId = await mkTenant('CustOther');

    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer('readonly') });
    await db
      .insert(tenantMembers)
      .values({ userId: (me.json() as { id: string }).id, tenantId, role: 'readonly' });

    const [venue] = await db.insert(venues).values({ tenantId, name: 'Cust Venue' }).returning();
    const [consumer] = await db
      .insert(users)
      .values({
        firebaseUid: `fbuid_cust_consumer_${Date.now()}`,
        displayName: 'Mia Online',
        phoneE164: `+9177777${String(Date.now()).slice(-5)}`,
      })
      .returning();

    const walkIn = (customerName: string, customerContact: string | null, daysAgo: number) => ({
      tenantId,
      venueId: venue!.id,
      itemType: 'slot' as const,
      channel: 'walkin' as const,
      paymentMethod: 'external' as const,
      status: 'confirmed' as const,
      customerName,
      customerContact,
      totalPaise: 10000,
      createdAt: new Date(Date.now() - daysAgo * 86_400_000),
    });

    await db.insert(bookings).values([
      // Ravi, three times, typed three ways — one person.
      walkIn('Ravi Kumar', '+91 98765 43210', 30),
      walkIn('ravi kumar', '9876543210', 10),
      { ...walkIn('Ravi Kumar', '+919876543210', 2), itemType: 'event' },
      // Same phone, another name: the household's other member.
      walkIn('Priya Kumar', '9876543210', 5),
      // Cancelled bookings still say who the customer was.
      { ...walkIn('Arjun Cancelled', 'arjun@example.com', 1), status: 'cancelled' as const },
      // A consumer who booked online: their account supplies the details.
      {
        ...walkIn('ignored', null, 3),
        channel: 'circls' as const,
        paymentMethod: 'razorpay_route' as const,
        customerName: null,
        customerContact: null,
        customerUserId: consumer!.id,
      },
    ]);

    // A member added by hand has no bookings row at all.
    const [plan] = await db
      .insert(memberships)
      .values({ tenantId, name: 'Gold', pricePaise: 0, durationDays: 30 })
      .returning();
    await db.insert(userMemberships).values({
      membershipId: plan!.id,
      userId: null,
      startsAt: new Date(),
      endsAt: new Date(Date.now() + 30 * 86_400_000),
      status: 'active',
      externalName: 'Sana Member',
      externalContact: 'sana@example.com',
    });

    // Someone else's customer must never show up here.
    await db.insert(bookings).values({
      ...walkIn('Ravi Elsewhere', '9876543210', 1),
      tenantId: otherTenantId,
      venueId: null,
    });
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  it('folds one person typed several ways into one row, most recent spelling first', async () => {
    const found = await customers('ravi');
    expect(found.map((c) => c.name)).toEqual(['Ravi Kumar']);
    const ravi = found[0]!;
    expect(ravi.contact).toBe('+919876543210');
    expect(ravi.timesSeen).toBe(3);
    expect([...ravi.kinds].sort()).toEqual(['event', 'slot']);
  });

  it('finds people by any run of digits in their phone, however it was punctuated', async () => {
    const names = (await customers('98765 432')).map((c) => c.name).sort();
    // Same number, two names: two people, both offered.
    expect(names).toEqual(['Priya Kumar', 'Ravi Kumar']);
    expect((await customers('+91 98765')).map((c) => c.name).sort()).toEqual(['Priya Kumar', 'Ravi Kumar']);
  });

  it('orders by when they were last seen', async () => {
    const found = await customers('kumar');
    expect(found.map((c) => c.name)).toEqual(['Ravi Kumar', 'Priya Kumar']);
  });

  it('includes cancelled bookings, online customers, and hand-added members', async () => {
    expect((await customers('arjun'))[0]).toMatchObject({
      name: 'Arjun Cancelled',
      contact: 'arjun@example.com',
    });
    expect((await customers('mia'))[0]).toMatchObject({ name: 'Mia Online', kinds: ['slot'] });
    expect((await customers('sana@'))[0]).toMatchObject({
      name: 'Sana Member',
      contact: 'sana@example.com',
      kinds: ['membership'],
    });
  });

  it('treats the query as text, not a pattern', async () => {
    expect(await customers('%%')).toEqual([]);
    expect(await customers('r_vi')).toEqual([]);
    expect(await customers('ku%ar')).toEqual([]);
  });

  it('never crosses organisations', async () => {
    expect((await customers('elsewhere'))).toEqual([]);
  });

  it('respects the limit', async () => {
    const res = await search('kumar', 'owner', '&limit=1');
    expect(res.statusCode).toBe(200);
    expect((res.json() as { customers: Suggestion[] }).customers).toHaveLength(1);
  });

  it('refuses a query shorter than two characters', async () => {
    expect((await search('r')).statusCode).toBe(400);
    expect((await search('  ')).statusCode).toBe(400);
  });

  it('is desk work: Read-only members and non-members are refused', async () => {
    const ro = await search('ravi', 'readonly');
    expect(ro.statusCode).toBe(403);
    expect(ro.json().error.code).toBe('forbidden_capability');
    expect((await search('ravi', 'other')).statusCode).toBe(403);
  });
});
