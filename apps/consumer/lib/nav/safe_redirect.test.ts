import { describe, expect, it } from 'vitest';
import { safeRedirectPath } from './safe_redirect';

describe('safeRedirectPath', () => {
  it('keeps a same-site path, with its query and hash', () => {
    expect(safeRedirectPath('/me/bookings?from=checkout#top')).toBe('/me/bookings?from=checkout#top');
    expect(safeRedirectPath('/')).toBe('/');
  });

  it('falls back to the home page when the value is missing', () => {
    expect(safeRedirectPath(null)).toBe('/');
    expect(safeRedirectPath(undefined)).toBe('/');
    expect(safeRedirectPath('')).toBe('/');
  });

  it.each([
    'https://evil.example/',
    'http://evil.example',
    '//evil.example',
    '/\\evil.example',
    '\\\\evil.example',
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,hi',
    'evil.example',
    'me/bookings',
    ' /me',
    '/me\n',
    '/\t/evil.example',
    '/me\u0000',
  ])('rejects %j', (value) => {
    expect(safeRedirectPath(value)).toBe('/');
  });

  it('honours a custom fallback', () => {
    expect(safeRedirectPath('https://evil.example', '/me')).toBe('/me');
  });

  it('normalises dot segments without leaving the site', () => {
    expect(safeRedirectPath('/a/../me')).toBe('/me');
  });
});
