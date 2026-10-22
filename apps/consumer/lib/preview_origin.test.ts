import { describe, expect, it } from 'vitest';
import { trustedParentOrigin } from './preview_origin';

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
