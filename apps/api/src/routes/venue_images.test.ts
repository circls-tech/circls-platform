import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      imgOwner: { uid: 'fbuid_imgowner', email: 'imgowner@x.com' },
      imgOther: { uid: 'fbuid_imgother', email: 'imgother@x.com' },
    };
    const u = map[token];
    if (!u) throw new Error('bad token');
    return u;
  }),
}));

const { closeDb } = await import('../db/client.js');
const { buildServer } = await import('../server.js');
const { getStorage } = await import('../lib/storage.js');

const runIntegration = Boolean(process.env.RUN_INTEGRATION);
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

/** Simulate the frontend's direct PUT to R2 by writing into the stub bucket. */
function simulateUpload(storageKey: string, contentType = 'image/jpeg', bytes = 1024): void {
  getStorage().writeForTesting!(storageKey, Buffer.alloc(bytes, 1), contentType);
}

describe.skipIf(!runIntegration)('venue images', () => {
  let app: FastifyInstance;
  let venueId: string;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
    const t = await app.inject({
      method: 'POST',
      url: '/v1/tenants',
      headers: bearer('imgOwner'),
      payload: { name: 'Image Co', slug: `imgco-${Date.now()}` },
    });
    const tenantId = t.json().id;
    const v = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/venues`,
      headers: bearer('imgOwner'),
      payload: { name: 'Gallery Hall' },
    });
    venueId = v.json().id;
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  it('presigns an upload under the venue prefix', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/venues/${venueId}/images/upload-presign`,
      headers: bearer('imgOwner'),
      payload: { contentType: 'image/jpeg' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.storageKey.startsWith(`venues/${venueId}/`)).toBe(true);
    expect(body.uploadUrl).toBeTruthy();
  });

  it('rejects an unsupported content type', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/venues/${venueId}/images/upload-presign`,
      headers: bearer('imgOwner'),
      payload: { contentType: 'application/pdf' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('unsupported_media_type');
  });

  it('blocks a non-member from presigning', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/venues/${venueId}/images/upload-presign`,
      headers: bearer('imgOther'),
      payload: { contentType: 'image/jpeg' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('finalizes after upload and assigns sequential positions', async () => {
    // First image → position 0
    const p1 = await app.inject({
      method: 'POST',
      url: `/v1/venues/${venueId}/images/upload-presign`,
      headers: bearer('imgOwner'),
      payload: { contentType: 'image/jpeg' },
    });
    const key1 = p1.json().storageKey;
    simulateUpload(key1, 'image/jpeg');
    const f1 = await app.inject({
      method: 'POST',
      url: `/v1/venues/${venueId}/images`,
      headers: bearer('imgOwner'),
      payload: { storageKey: key1 },
    });
    expect(f1.statusCode).toBe(200);
    expect(f1.json().position).toBe(0);
    expect(f1.json().url).toContain(key1);
    expect(f1.json().sizeBytes).toBe(1024);

    // Second image → position 1
    const p2 = await app.inject({
      method: 'POST',
      url: `/v1/venues/${venueId}/images/upload-presign`,
      headers: bearer('imgOwner'),
      payload: { contentType: 'image/png' },
    });
    const key2 = p2.json().storageKey;
    simulateUpload(key2, 'image/png');
    const f2 = await app.inject({
      method: 'POST',
      url: `/v1/venues/${venueId}/images`,
      headers: bearer('imgOwner'),
      payload: { storageKey: key2 },
    });
    expect(f2.statusCode).toBe(200);
    expect(f2.json().position).toBe(1);
  });

  it('rejects finalize when the object was never uploaded', async () => {
    const p = await app.inject({
      method: 'POST',
      url: `/v1/venues/${venueId}/images/upload-presign`,
      headers: bearer('imgOwner'),
      payload: { contentType: 'image/jpeg' },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/venues/${venueId}/images`,
      headers: bearer('imgOwner'),
      payload: { storageKey: p.json().storageKey },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('upload_not_found');
  });

  it('rejects a storageKey that does not belong to the venue', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/venues/${venueId}/images`,
      headers: bearer('imgOwner'),
      payload: { storageKey: 'venues/00000000-0000-0000-0000-000000000099/x.jpg' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('bad_storage_key');
  });

  it('lists images ordered by position', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/venues/${venueId}/images`,
      headers: bearer('imgOwner'),
    });
    expect(res.statusCode).toBe(200);
    const imgs = res.json();
    expect(imgs.length).toBeGreaterThanOrEqual(2);
    expect(imgs[0].position).toBeLessThanOrEqual(imgs[1].position);
    expect(imgs[0].url).toBeTruthy();
  });

  it('deletes an image', async () => {
    const list = await app.inject({
      method: 'GET',
      url: `/v1/venues/${venueId}/images`,
      headers: bearer('imgOwner'),
    });
    const target = list.json()[0];
    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/venues/${venueId}/images/${target.id}`,
      headers: bearer('imgOwner'),
    });
    expect(del.statusCode).toBe(200);
    expect(del.json().ok).toBe(true);

    // Object is gone from storage too.
    expect(await getStorage().head(target.storageKey)).toBeNull();
  });
});
