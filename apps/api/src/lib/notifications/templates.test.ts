import { describe, expect, it } from 'vitest';
import { renderTemplate, templateSupportsChannel } from './templates.js';

describe('renderTemplate (pure)', () => {
  it('renders booking.confirmed SMS with substitutions', () => {
    const out = renderTemplate('sms', 'booking.confirmed', {
      venueName: 'Tigers Arena',
      arenaName: 'Court 1',
      when: '04 Jul 2026, 18:00',
      totalRupees: '500.00',
      bookingId: 'abc-123',
    });
    expect(out.subject).toBeUndefined();
    expect(out.body).toContain('Tigers Arena');
    expect(out.body).toContain('Court 1');
    expect(out.body).toContain('04 Jul 2026, 18:00');
    expect(out.body).toContain('abc-123');
    // SMS template should not contain unresolved {{ markers
    expect(out.body).not.toMatch(/\{\{[^}]+\}\}/);
  });

  it('renders booking.confirmed email with subject + body', () => {
    const out = renderTemplate('email', 'booking.confirmed', {
      customerName: 'Asha',
      venueName: 'Tigers Arena',
      arenaName: 'Court 1',
      when: '04 Jul 2026, 18:00',
      totalRupees: '500.00',
      bookingId: 'abc-123',
    });
    expect(out.subject).toBe('Booking confirmed — Tigers Arena');
    expect(out.body).toContain('Hi Asha,');
    expect(out.body).toContain('Rs 500.00');
    expect(out.body).toContain('abc-123');
  });

  it('substitutes missing vars with empty string', () => {
    const out = renderTemplate('sms', 'otp.login', { code: '' });
    // Should NOT keep the literal {{code}} — render should produce an empty hole.
    expect(out.body).not.toContain('{{');
    expect(out.body).toContain('Your Circls login code is');
  });

  it('throws on unknown template key', () => {
    expect(() => renderTemplate('sms', 'does.not.exist', {})).toThrow(/unknown_template/);
  });

  it('throws when the channel is not supported for that key', () => {
    // otp.login is sms-only; asking for email should throw.
    expect(() => renderTemplate('email', 'otp.login', { code: '123456' })).toThrow(
      /channel_not_supported/,
    );
  });

  it('templateSupportsChannel reflects the matrix', () => {
    expect(templateSupportsChannel('sms', 'booking.confirmed')).toBe(true);
    expect(templateSupportsChannel('whatsapp', 'booking.confirmed')).toBe(true);
    expect(templateSupportsChannel('email', 'booking.confirmed')).toBe(true);
    expect(templateSupportsChannel('whatsapp', 'booking.cancelled')).toBe(false);
    expect(templateSupportsChannel('email', 'otp.login')).toBe(false);
    expect(templateSupportsChannel('sms', 'kyc.verified')).toBe(false);
  });
});
