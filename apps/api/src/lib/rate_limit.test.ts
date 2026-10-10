import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { verifiedIdentityKey } from './rate_limit.js';

function request(partial: Record<string, unknown>): FastifyRequest {
  return { ip: '203.0.113.9', headers: {}, ...partial } as unknown as FastifyRequest;
}

describe('verifiedIdentityKey', () => {
  it('keys a Firebase-authenticated request on its verified uid', () => {
    expect(verifiedIdentityKey(request({ authUser: { firebaseUid: 'fb_1' } }))).toBe('uid:fb_1');
  });

  it('keys an API-key request on the key id', () => {
    expect(verifiedIdentityKey(request({ apiKey: { id: 'key_1' } }))).toBe('key:key_1');
  });

  it('falls back to the client IP and never to the raw Authorization header', () => {
    const key = verifiedIdentityKey(request({ headers: { authorization: 'Bearer anything' } }));
    expect(key).toBe('ip:203.0.113.9');
  });
});
