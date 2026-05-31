import { beforeEach, describe, expect, it } from 'vitest';
import { __resetStorageForTesting, getStorage } from './storage.js';

// Unit tests for the stub adapter's new surface (publicUrl / head / delete).
// These run without a DB or R2 creds — getStorage() falls back to the stub.
describe('StubStorage adapter', () => {
  beforeEach(() => {
    __resetStorageForTesting();
  });

  it('runs in stub mode when no R2 creds are present', () => {
    expect(getStorage().mode).toBe('stub');
  });

  it('presignUpload echoes the key and pins Content-Type', async () => {
    const s = getStorage();
    const up = await s.presignUpload({ key: 'venues/v1/a.jpg', contentType: 'image/jpeg' });
    expect(up.storageKey).toBe('venues/v1/a.jpg');
    expect(up.headers['Content-Type']).toBe('image/jpeg');
    expect(up.expiresIn).toBeGreaterThan(0);
  });

  it('publicUrl includes the key', () => {
    expect(getStorage().publicUrl('venues/v1/a.jpg')).toContain('venues/v1/a.jpg');
  });

  it('head returns null before upload, metadata after', async () => {
    const s = getStorage();
    expect(await s.head('venues/v1/a.jpg')).toBeNull();
    s.writeForTesting!('venues/v1/a.jpg', Buffer.from('hello'), 'image/jpeg');
    const h = await s.head('venues/v1/a.jpg');
    expect(h).toEqual({ sizeBytes: 5, contentType: 'image/jpeg' });
  });

  it('delete removes the object', async () => {
    const s = getStorage();
    s.writeForTesting!('venues/v1/a.jpg', Buffer.from('x'), 'image/png');
    await s.delete('venues/v1/a.jpg');
    expect(await s.head('venues/v1/a.jpg')).toBeNull();
  });
});
