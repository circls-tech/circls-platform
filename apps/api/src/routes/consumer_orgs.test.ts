import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Public organisers directory (GET /v1/consumer/orgs). Integration-gated
// (needs Postgres); mirrors trust_metadata.test.ts.
vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      owner: { uid: 'fbuid_dirowner', email: 'dirowner@x.com', email_verified: true },
    };
    const u = map[token];
    if (!u) throw new Error('bad token');
    return u;
  }),
}));

const { eq } = await import('drizzle-orm');
const { closeDb, db } = await import('../db/client.js');
const { tenants } = await import('../db/schema/index.js');
const { buildServer } = await import('../server.js');

const runIntegration = Boolean(process.env.RUN_INTEGRATION);
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

describe.skipIf(!runIntegration)('public organisers directory', () => {
  let app: FastifyInstance;
  const stamp = Date.now();
  // Created "Zz…" before "Aa…" so a sorted response proves ordering, not insertion order.
  const slugA = `dir-aa-${stamp}`;
  const slugZ = `dir-zz-${stamp}`;
  const slugSuspended = `dir-suspended-${stamp}`;
  const slugPlatform = `dir-platform-${stamp}`;

  async function createTenant(name: string, slug: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tenants',
      headers: bearer('owner'),
      payload: { name, slug, country: 'India', acceptTerms: true },
    });
    expect(res.statusCode).toBe(200);
    return res.json().id;
  }

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
    await createTenant(`Zz Dir Org ${stamp}`, slugZ);
    await createTenant(`Aa Dir Org ${stamp}`, slugA);
    const suspendedId = await createTenant(`Suspended Dir Org ${stamp}`, slugSuspended);
    const platformId = await createTenant(`Platform Dir Org ${stamp}`, slugPlatform);
    await db.update(tenants).set({ status: 'suspended' }).where(eq(tenants.id, suspendedId));
    await db.update(tenants).set({ isPlatform: true }).where(eq(tenants.id, platformId));
  });
  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  it('lists active non-platform orgs A→Z; hides suspended and platform orgs', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/consumer/orgs' });
    expect(res.statusCode).toBe(200);
    const rows: { slug: string }[] = res.json().rows;

    const slugs = rows.map((r) => r.slug);
    expect(slugs).toContain(slugA);
    expect(slugs).toContain(slugZ);
    expect(slugs).not.toContain(slugSuspended);
    expect(slugs).not.toContain(slugPlatform);
    // A→Z by name (other tenants may be interleaved; relative order is what matters).
    expect(slugs.indexOf(slugA)).toBeLessThan(slugs.indexOf(slugZ));
  });

  it('rows carry only the public summary fields', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/consumer/orgs' });
    const row = res.json().rows.find((r: { slug: string }) => r.slug === slugA);
    expect(row).toBeDefined();
    expect(Object.keys(row).sort()).toEqual(
      ['city', 'country', 'description', 'id', 'logoUrl', 'name', 'slug'],
    );
  });
});
