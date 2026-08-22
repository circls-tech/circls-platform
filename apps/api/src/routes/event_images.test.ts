import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      eviOwner: { uid: 'fbuid_eviowner', email: 'eviowner@x.com', email_verified: true },
      eviOther: { uid: 'fbuid_eviother', email: 'eviother@x.com', email_verified: true },
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

function simulateUpload(storageKey: string, contentType = 'image/jpeg', bytes = 1024): void {
  getStorage().writeForTesting!(storageKey, Buffer.alloc(bytes, 1), contentType);
}

describe.skipIf(!runIntegration)('event images', () => {
  let app: FastifyInstance;
  let eventId: string;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
    const t = await app.inject({
      method: 'POST',
      url: '/v1/tenants',
      headers: bearer('eviOwner'),
      payload: { name: 'Event Image Co', slug: `evico-${Date.now()}`, country: 'India', acceptTerms: true },
    });
    const tenantId = t.json().id;
    const v = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/venues`,
      headers: bearer('eviOwner'),
      payload: { name: 'Event Hall' },
    });
    const venueId = v.json().id;
    const ev = await app.inject({
      method: 'POST',
      url: `/v1/venues/${venueId}/events`,
      headers: bearer('eviOwner'),
      payload: {
        name: 'Launch Night',
        startsAt: '2099-01-01T18:00:00.000Z',
        endsAt: '2099-01-01T21:00:00.000Z',
        tiers: [{ name: 'General', pricePaise: 50000 }],
      },
    });
    eventId = ev.json().id;
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  it('presigns an upload under the event prefix', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${eventId}/images/upload-presign`,
      headers: bearer('eviOwner'),
      payload: { contentType: 'image/jpeg' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().storageKey.startsWith(`events/${eventId}/`)).toBe(true);
  });

  it('rejects an unsupported content type', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${eventId}/images/upload-presign`,
      headers: bearer('eviOwner'),
      payload: { contentType: 'application/pdf' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('unsupported_media_type');
  });

  it('blocks a non-member', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${eventId}/images/upload-presign`,
      headers: bearer('eviOther'),
      payload: { contentType: 'image/jpeg' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('finalizes after upload with sequential positions', async () => {
    const p1 = await app.inject({
      method: 'POST',
      url: `/v1/events/${eventId}/images/upload-presign`,
      headers: bearer('eviOwner'),
      payload: { contentType: 'image/jpeg' },
    });
    const key1 = p1.json().storageKey;
    simulateUpload(key1, 'image/jpeg');
    const f1 = await app.inject({
      method: 'POST',
      url: `/v1/events/${eventId}/images`,
      headers: bearer('eviOwner'),
      payload: { storageKey: key1 },
    });
    expect(f1.statusCode).toBe(200);
    expect(f1.json().position).toBe(0);
    expect(f1.json().url).toContain(key1);

    const p2 = await app.inject({
      method: 'POST',
      url: `/v1/events/${eventId}/images/upload-presign`,
      headers: bearer('eviOwner'),
      payload: { contentType: 'image/png' },
    });
    const key2 = p2.json().storageKey;
    simulateUpload(key2, 'image/png');
    const f2 = await app.inject({
      method: 'POST',
      url: `/v1/events/${eventId}/images`,
      headers: bearer('eviOwner'),
      payload: { storageKey: key2 },
    });
    expect(f2.json().position).toBe(1);
  });

  it('rejects a storageKey from another event', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${eventId}/images`,
      headers: bearer('eviOwner'),
      payload: { storageKey: 'events/00000000-0000-0000-0000-000000000099/x.jpg' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('bad_storage_key');
  });

  it('stores client-reported dimensions and defaults the focal point to centre', async () => {
    const p = await app.inject({
      method: 'POST',
      url: `/v1/events/${eventId}/images/upload-presign`,
      headers: bearer('eviOwner'),
      payload: { contentType: 'image/jpeg' },
    });
    const key = p.json().storageKey;
    simulateUpload(key, 'image/jpeg');
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${eventId}/images`,
      headers: bearer('eviOwner'),
      payload: { storageKey: key, width: 1200, height: 1800 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ width: 1200, height: 1800, focalX: 0.5, focalY: 0.5 });
  });

  it('leaves dimensions null when the client cannot report them', async () => {
    const list = await app.inject({
      method: 'GET',
      url: `/v1/events/${eventId}/images`,
      headers: bearer('eviOwner'),
    });
    // The first two images were finalized without width/height.
    expect(list.json()[0]).toMatchObject({ width: null, height: null, focalX: 0.5, focalY: 0.5 });
  });

  it('rejects out-of-range dimensions', async () => {
    const p = await app.inject({
      method: 'POST',
      url: `/v1/events/${eventId}/images/upload-presign`,
      headers: bearer('eviOwner'),
      payload: { contentType: 'image/jpeg' },
    });
    const key = p.json().storageKey;
    simulateUpload(key, 'image/jpeg');
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${eventId}/images`,
      headers: bearer('eviOwner'),
      payload: { storageKey: key, width: 0, height: 999999 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('bad_request');
  });

  it('reorders the gallery so the chosen photo becomes the cover', async () => {
    const before = await app.inject({
      method: 'GET',
      url: `/v1/events/${eventId}/images`,
      headers: bearer('eviOwner'),
    });
    const ids = before.json().map((i: { id: string }) => i.id);
    expect(ids.length).toBeGreaterThanOrEqual(3);
    const reversed = [...ids].reverse();

    const res = await app.inject({
      method: 'PUT',
      url: `/v1/events/${eventId}/images/order`,
      headers: bearer('eviOwner'),
      payload: { imageIds: reversed },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().map((i: { id: string }) => i.id)).toEqual(reversed);
    expect(res.json().map((i: { position: number }) => i.position)).toEqual(
      reversed.map((_: string, i: number) => i),
    );

    // Idempotent: sending the same order again is a no-op, not an error.
    const again = await app.inject({
      method: 'PUT',
      url: `/v1/events/${eventId}/images/order`,
      headers: bearer('eviOwner'),
      payload: { imageIds: reversed },
    });
    expect(again.json().map((i: { id: string }) => i.id)).toEqual(reversed);
  });

  it('rejects an order that is not a full permutation', async () => {
    const list = await app.inject({
      method: 'GET',
      url: `/v1/events/${eventId}/images`,
      headers: bearer('eviOwner'),
    });
    const ids = list.json().map((i: { id: string }) => i.id);

    const partial = await app.inject({
      method: 'PUT',
      url: `/v1/events/${eventId}/images/order`,
      headers: bearer('eviOwner'),
      payload: { imageIds: ids.slice(0, 1) },
    });
    expect(partial.statusCode).toBe(400);
    expect(partial.json().error.code).toBe('bad_image_order');

    const duplicated = await app.inject({
      method: 'PUT',
      url: `/v1/events/${eventId}/images/order`,
      headers: bearer('eviOwner'),
      payload: { imageIds: ids.map(() => ids[0]) },
    });
    expect(duplicated.statusCode).toBe(400);
    expect(duplicated.json().error.code).toBe('bad_image_order');

    const foreign = await app.inject({
      method: 'PUT',
      url: `/v1/events/${eventId}/images/order`,
      headers: bearer('eviOwner'),
      payload: {
        imageIds: [...ids.slice(0, ids.length - 1), '00000000-0000-0000-0000-0000000000ff'],
      },
    });
    expect(foreign.statusCode).toBe(400);
    expect(foreign.json().error.code).toBe('bad_image_order');
  });

  it('moves an image focal point', async () => {
    const list = await app.inject({
      method: 'GET',
      url: `/v1/events/${eventId}/images`,
      headers: bearer('eviOwner'),
    });
    const imageId = list.json()[0].id;

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/events/${eventId}/images/${imageId}`,
      headers: bearer('eviOwner'),
      payload: { focalX: 0.25, focalY: 0.1 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: imageId, focalX: 0.25, focalY: 0.1 });
  });

  it('rejects a focal point outside 0..1', async () => {
    const list = await app.inject({
      method: 'GET',
      url: `/v1/events/${eventId}/images`,
      headers: bearer('eviOwner'),
    });
    const imageId = list.json()[0].id;

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/events/${eventId}/images/${imageId}`,
      headers: bearer('eviOwner'),
      payload: { focalX: 1.5, focalY: -0.2 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('bad_request');
  });

  it('404s a focal patch for an image that is not on this event', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/events/${eventId}/images/00000000-0000-0000-0000-0000000000ff`,
      headers: bearer('eviOwner'),
      payload: { focalX: 0.5, focalY: 0.5 },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('event_image_not_found');
  });

  it('lists then deletes images', async () => {
    const list = await app.inject({
      method: 'GET',
      url: `/v1/events/${eventId}/images`,
      headers: bearer('eviOwner'),
    });
    expect(list.statusCode).toBe(200);
    const imgs = list.json();
    expect(imgs.length).toBeGreaterThanOrEqual(2);

    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/events/${eventId}/images/${imgs[0].id}`,
      headers: bearer('eviOwner'),
    });
    expect(del.statusCode).toBe(200);
    expect(await getStorage().head(imgs[0].storageKey)).toBeNull();
  });
});
