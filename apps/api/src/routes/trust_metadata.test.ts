import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Epic #106 — org/brand (#107/#108), venue trust metadata (#109), membership
// enrichment (#110). Integration-gated (needs Postgres); mirrors venues.test.ts.
vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      owner: { uid: 'fbuid_towner', email: 'towner@x.com', email_verified: true },
      staff: { uid: 'fbuid_tstaff', email: 'tstaff@x.com', email_verified: true },
      other: { uid: 'fbuid_tother', email: 'tother@x.com', email_verified: true },
    };
    const u = map[token];
    if (!u) throw new Error('bad token');
    return u;
  }),
}));

const { eq } = await import('drizzle-orm');
const { closeDb, db } = await import('../db/client.js');
const { memberships, tenantMembers } = await import('../db/schema/index.js');
const { buildServer } = await import('../server.js');

const runIntegration = Boolean(process.env.RUN_INTEGRATION);
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

describe.skipIf(!runIntegration)('trust metadata (epic #106)', () => {
  let app: FastifyInstance;
  let tenantId: string;
  let slug: string;
  let venueId: string;
  let membershipId: string;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
    slug = `trust-${Date.now()}`;
    const t = await app.inject({
      method: 'POST',
      url: '/v1/tenants',
      headers: bearer('owner'),
      payload: { name: 'Trust Co', slug },
    });
    tenantId = t.json().id;
    const v = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/venues`,
      headers: bearer('owner'),
      payload: { name: 'Trust Venue' },
    });
    venueId = v.json().id;
    const m = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/memberships`,
      headers: bearer('owner'),
      payload: { name: 'Gold', pricePaise: 0, durationDays: 30 },
    });
    membershipId = m.json().id;
  });
  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  // ── #107 Org profile ───────────────────────────────────────────────────────
  it('owner reads + patches the org profile (round-trips)', async () => {
    const patch = await app.inject({
      method: 'PATCH',
      url: `/v1/tenants/${tenantId}`,
      headers: bearer('owner'),
      payload: {
        description: 'We run great courts.',
        contactEmail: 'hi@trust.co',
        websiteUrl: 'https://trust.co',
        socials: { instagram: 'trustco' },
        city: 'Nagpur',
        country: 'India',
      },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().description).toBe('We run great courts.');
    expect(patch.json().socials).toEqual({ instagram: 'trustco' });
    expect(patch.json().logoUrl).toBeNull();

    const get = await app.inject({ method: 'GET', url: `/v1/tenants/${tenantId}`, headers: bearer('owner') });
    expect(get.statusCode).toBe(200);
    expect(get.json().city).toBe('Nagpur');
    // Billing fields never appear on the profile DTO.
    expect(get.json()).not.toHaveProperty('commissionBps');
    expect(get.json()).not.toHaveProperty('subscriptionStatus');
  });

  it('rejects an invalid profile payload (400)', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/tenants/${tenantId}`,
      headers: bearer('owner'),
      payload: { contactEmail: 'not-an-email' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('blocks a non-member from patching the org (403)', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/tenants/${tenantId}`,
      headers: bearer('other'),
      payload: { description: 'sneaky' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('tenant_forbidden');
  });

  it('blocks a staff member (lacks tenant.update) from patching the org (403)', async () => {
    // Materialise the staff user, then attach them to the tenant as staff.
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer('staff') });
    const staffUserId = me.json().id;
    await db.insert(tenantMembers).values({ userId: staffUserId, tenantId, role: 'staff' });
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/tenants/${tenantId}`,
      headers: bearer('staff'),
      payload: { description: 'nope' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('forbidden_capability');
  });

  // ── #108 Consumer org exposure ───────────────────────────────────────────────
  it('exposes the public org by slug without private fields, 404 for missing', async () => {
    const ok = await app.inject({ method: 'GET', url: `/v1/consumer/orgs/${slug}` });
    expect(ok.statusCode).toBe(200);
    const org = ok.json();
    expect(org.slug).toBe(slug);
    expect(org.description).toBe('We run great courts.');
    expect(org).not.toHaveProperty('commissionBps');
    expect(org).not.toHaveProperty('subscriptionStatus');
    expect(org).not.toHaveProperty('isPlatform');
    expect(org).not.toHaveProperty('status');

    const missing = await app.inject({ method: 'GET', url: `/v1/consumer/orgs/does-not-exist-${Date.now()}` });
    expect(missing.statusCode).toBe(404);
  });

  // ── #109 Venue trust metadata ────────────────────────────────────────────────
  it('patches + persists venue trust metadata; rejects an unknown amenity', async () => {
    const ok = await app.inject({
      method: 'PATCH',
      url: `/v1/venues/${venueId}`,
      headers: bearer('owner'),
      payload: {
        description: 'Indoor courts',
        amenities: ['parking', 'wifi'],
        openingHours: { '1': [{ open: '09:00', close: '22:00' }], '0': [] },
        contactPhone: '+911234567890',
        city: 'Nagpur',
        country: 'India',
        status: 'active',
      },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().amenities).toEqual(['parking', 'wifi']);
    // Coordinates are derived from the address by the geocoder (stub gazetteer),
    // and the structured address is mirrored into address_json for the consumer.
    expect(ok.json().lat).toBeCloseTo(21.15, 1);
    expect(ok.json().lng).toBeCloseTo(79.09, 1);
    expect(ok.json().addressJson).toMatchObject({ city: 'Nagpur', country: 'India' });

    const bad = await app.inject({
      method: 'PATCH',
      url: `/v1/venues/${venueId}`,
      headers: bearer('owner'),
      payload: { amenities: ['helipad'] },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('consumer venue payload carries trust metadata + a brand summary', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/consumer/venues/${venueId}` });
    expect(res.statusCode).toBe(200);
    const venue = res.json().venue;
    expect(venue.description).toBe('Indoor courts');
    expect(venue.amenities).toEqual(['parking', 'wifi']);
    expect(venue.brand).toMatchObject({ id: tenantId, slug, name: 'Trust Co' });
    expect(venue.brand).not.toHaveProperty('commissionBps');
  });

  // ── #110 Membership enrichment ───────────────────────────────────────────────
  it('patches typed benefits + terms; consumer payload returns them', async () => {
    const patch = await app.inject({
      method: 'PATCH',
      url: `/v1/tenants/${tenantId}/memberships/${membershipId}`,
      headers: bearer('owner'),
      payload: {
        benefits: { items: [{ label: 'Priority booking', detail: '24h ahead' }, { label: 'Free guest pass' }] },
        terms: 'Non-transferable.',
      },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().benefits.items).toHaveLength(2);

    // Mark active (admin approval is out of scope here) so it is consumer-visible.
    await db.update(memberships).set({ status: 'active' }).where(eq(memberships.id, membershipId));
    const pub = await app.inject({ method: 'GET', url: `/v1/consumer/memberships/${membershipId}` });
    expect(pub.statusCode).toBe(200);
    expect(pub.json().benefits.items[0].label).toBe('Priority booking');
    expect(pub.json().terms).toBe('Non-transferable.');
    expect(pub.json().artworkUrl).toBeNull();
    expect(pub.json().brand).toMatchObject({ slug });
  });

  it('rejects malformed benefits (400)', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/tenants/${tenantId}/memberships/${membershipId}`,
      headers: bearer('owner'),
      payload: { benefits: { items: [{ detail: 'no label' }] } },
    });
    expect(res.statusCode).toBe(400);
  });
});
