import { describe, expect, it } from 'vitest';
import { scratchMessageVerdict, trustedParentOrigin } from './preview_origin';

describe('trustedParentOrigin', () => {
  it('keeps a bare http(s) origin', () => {
    expect(trustedParentOrigin('https://partners.circls.app')).toBe('https://partners.circls.app');
    expect(trustedParentOrigin('http://localhost:3001')).toBe('http://localhost:3001');
  });

  it.each([
    undefined,
    null,
    42,
    '',
    '*',
    'null',
    'partners.circls.app',
    'https://partners.circls.app/',
    'https://partners.circls.app/events',
    'javascript:alert(1)',
    'data:text/html,hi',
  ])('refuses %j', (value) => {
    expect(trustedParentOrigin(value)).toBeNull();
  });
});

describe('scratchMessageVerdict', () => {
  const parent = { name: 'parent frame' };
  const portal = 'https://partners.circls.app';

  it('accepts the parent frame on the partner portal origin', () => {
    expect(scratchMessageVerdict({ source: parent, origin: portal }, parent, portal)).toBe('accept');
  });

  it('ignores anything that is not the parent frame, whatever its origin', () => {
    expect(scratchMessageVerdict({ source: {}, origin: portal }, parent, portal)).toBe('ignore');
    expect(scratchMessageVerdict({ source: null, origin: portal }, parent, portal)).toBe('ignore');
  });

  it.each([
    'https://evil.example',
    'https://partners.circls.app.evil.example',
    'http://partners.circls.app',
    'https://partners.circls.app:8443',
    'null',
    '',
  ])('refuses the parent frame posting from %j', (origin) => {
    expect(scratchMessageVerdict({ source: parent, origin }, parent, portal)).toBe('refuse');
  });
});
