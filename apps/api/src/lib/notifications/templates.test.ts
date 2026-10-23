import { describe, expect, it } from 'vitest';
import { isInternalTemplateKey, renderTemplate, templateSupportsChannel } from './templates.js';

// Plain templates: SMS, WhatsApp, and the emails with no design. The designed
// emails are covered in ./email_designs/designs.test.ts.
describe('renderTemplate (pure)', () => {
  it('renders booking.confirmed SMS with the item and time', () => {
    const out = renderTemplate('sms', 'booking.confirmed', {
      itemName: 'Tigers Arena · Court 1',
      when: 'Sat 4 Jul, 6:00–7:00 PM',
      bookingId: 'abc-123',
    });
    expect(out.subject).toBeUndefined();
    expect(out.body).toContain('Tigers Arena · Court 1');
    expect(out.body).toContain('Sat 4 Jul, 6:00–7:00 PM');
    expect(out.body).toContain('abc-123');
    // SMS template should not contain unresolved {{ markers
    expect(out.body).not.toMatch(/\{\{[^}]+\}\}/);
  });

  it('renders booking.rescheduled with the new time on every channel', () => {
    const payload = {
      customerName: 'Asha',
      itemName: 'Tigers Arena · Court 2',
      when: 'Sun 5 Jul, 7:00–8:00 PM',
      details: 'Venue: Tigers Arena\nArena: Court 2\nWhen: Sun 5 Jul, 7:00–8:00 PM\nTotal: ₹500',
      bookingId: 'abc-123',
    };
    for (const channel of ['sms', 'email', 'whatsapp'] as const) {
      const out = renderTemplate(channel, 'booking.rescheduled', payload);
      expect(out.body).toContain('Sun 5 Jul, 7:00–8:00 PM');
      expect(out.body).toContain('Court 2');
      expect(out.body).toContain('abc-123');
      expect(out.body).not.toMatch(/\{\{[^}]+\}\}/);
    }
    expect(renderTemplate('email', 'booking.rescheduled', payload).subject).toContain('Tigers Arena');
  });

  it('names the event, not an arena, in event booking texts', () => {
    const out = renderTemplate('sms', 'booking.reminder_t24h', {
      itemName: 'Coffee Tasting',
      when: 'Sun 25 Oct, 5:00 PM',
    });
    expect(out.body).toBe('Circls reminder: Your booking for Coffee Tasting is tomorrow — Sun 25 Oct, 5:00 PM.');
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
    expect(() => renderTemplate('email', 'otp.login', { code: '123456' })).toThrow(/channel_not_supported/);
  });

  it('templateSupportsChannel reflects the matrix (designed emails live elsewhere)', () => {
    expect(templateSupportsChannel('sms', 'booking.confirmed')).toBe(true);
    expect(templateSupportsChannel('whatsapp', 'booking.confirmed')).toBe(true);
    expect(templateSupportsChannel('email', 'booking.confirmed')).toBe(false);
    expect(templateSupportsChannel('email', 'booking.rescheduled')).toBe(true);
    expect(templateSupportsChannel('whatsapp', 'booking.cancelled')).toBe(false);
    expect(templateSupportsChannel('email', 'otp.login')).toBe(false);
  });

  it('isInternalTemplateKey separates admin.* from customer/partner keys', () => {
    expect(isInternalTemplateKey('admin.listing_submitted')).toBe(true);
    expect(isInternalTemplateKey('admin.daily_digest')).toBe(true);
    expect(isInternalTemplateKey('booking.confirmed')).toBe(false);
    expect(isInternalTemplateKey('tenant.invitation')).toBe(false);
    expect(isInternalTemplateKey('administrator.x')).toBe(false);
  });

  it('renders the daily digest from its pre-rendered summary', () => {
    const out = renderTemplate('email', 'admin.daily_digest', {
      dateLabel: 'Mon 19 Oct 2026',
      summary: 'Bookings\n  New bookings: 3',
    });
    expect(out.subject).toBe('[Circls] Daily summary — Mon 19 Oct 2026');
    expect(out.body).toBe('Bookings\n  New bookings: 3');
  });
});
