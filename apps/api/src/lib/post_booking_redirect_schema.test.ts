import { describe, expect, it } from 'vitest';
import {
  isAllowedRedirectUrl,
  postBookingRedirectSchema,
  toPostBookingRedirect,
} from './post_booking_redirect_schema.js';

/** Parse + normalise in one step, the way the routes do. */
function normalise(input: unknown) {
  const parsed = postBookingRedirectSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, issues: parsed.error.issues };
  return { ok: true as const, value: toPostBookingRedirect(parsed.data) };
}

describe('isAllowedRedirectUrl', () => {
  it('accepts absolute http(s) links', () => {
    expect(isAllowedRedirectUrl('https://forms.gle/abc123')).toBe(true);
    expect(isAllowedRedirectUrl('http://example.com/waiver?event=42')).toBe(true);
    expect(isAllowedRedirectUrl('https://chat.whatsapp.com/ABCdef')).toBe(true);
  });

  it('rejects script-bearing and non-web schemes', () => {
    // The stored value ends up in an href / location.href on the consumer app.
    expect(isAllowedRedirectUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedRedirectUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isAllowedRedirectUrl('file:///etc/passwd')).toBe(false);
    expect(isAllowedRedirectUrl('mailto:someone@example.com')).toBe(false);
  });

  it('rejects anything that is not an absolute URL', () => {
    expect(isAllowedRedirectUrl('forms.gle/abc123')).toBe(false);
    expect(isAllowedRedirectUrl('/account/delete')).toBe(false);
    expect(isAllowedRedirectUrl('')).toBe(false);
  });
});

describe('postBookingRedirectSchema', () => {
  it('null clears the redirect', () => {
    expect(normalise(null)).toEqual({ ok: true, value: null });
  });

  it('fills in the optional fields', () => {
    expect(normalise({ url: 'https://forms.gle/abc123' })).toEqual({
      ok: true,
      value: { url: 'https://forms.gle/abc123', description: null, forced: false },
    });
  });

  it('keeps a description and the forced flag', () => {
    expect(
      normalise({
        url: 'https://chat.whatsapp.com/ABCdef',
        description: '  Join the squad chat  ',
        forced: true,
      }),
    ).toEqual({
      ok: true,
      value: {
        url: 'https://chat.whatsapp.com/ABCdef',
        description: 'Join the squad chat',
        forced: true,
      },
    });
  });

  it('treats a whitespace-only description as absent', () => {
    const result = normalise({ url: 'https://forms.gle/abc123', description: '   ' });
    expect(result.ok && result.value?.description).toBeNull();
  });

  it('refuses a javascript: URL', () => {
    expect(normalise({ url: 'javascript:alert(1)' }).ok).toBe(false);
  });

  it('refuses an over-long description', () => {
    expect(normalise({ url: 'https://forms.gle/a', description: 'x'.repeat(501) }).ok).toBe(false);
  });

  it('refuses an over-long URL', () => {
    expect(normalise({ url: `https://example.com/${'a'.repeat(2000)}` }).ok).toBe(false);
  });
});
