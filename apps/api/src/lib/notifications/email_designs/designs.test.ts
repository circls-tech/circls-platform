import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMAIL_DESIGNS, getEmailDesign, renderDesign, renderEmail } from './index.js';
import { LOGO_URL } from './layout.js';

const shared = {
  consumerUrl: 'https://circls.app',
  partnersUrl: 'https://partners.circls.app',
  adminUrl: 'https://admin.circls.app',
  canReply: true,
};

describe('every design renders cleanly with its sample', () => {
  for (const design of EMAIL_DESIGNS) {
    it(`${design.key}`, () => {
      const out = renderDesign(design, { ...shared, ...design.sample });
      expect(out.subject.length).toBeGreaterThan(0);
      expect(out.subject).not.toMatch(/\{\{|\}\}/);
      expect(out.html.startsWith('<!doctype html>')).toBe(true);
      expect(out.html).not.toMatch(/\{\{|\}\}/);
      expect(out.html).toContain(LOGO_URL);
      expect(out.text).not.toMatch(/\{\{|\}\}/);
      // No URL left half-built by a missing base.
      expect(out.html).not.toMatch(/href="\/|href=""/);
    });
  }
});

describe('design content', () => {
  it('booking confirmation: details, total and link', () => {
    const d = getEmailDesign('booking.confirmed')!;
    const out = renderDesign(d, { ...shared, ...d.sample });
    expect(out.subject).toBe('You’re booked in — Bandra Sports Club, Sat 4 Oct');
    expect(out.html).toContain('Turf 2 · 5-a-side');
    expect(out.html).toContain('BK-8F2K-9QD4');
    expect(out.html).toContain('₹1,200');
    expect(out.text).toContain('Arena: Turf 2 · 5-a-side');
  });

  it('cancellation: three wordings, and the refund boxes', () => {
    const d = getEmailDesign('booking.cancelled')!;
    const base = { ...shared, ...d.sample, eventCancelled: false, organizerRefundPending: false };
    const byOrganizer = renderDesign(d, { ...shared, ...d.sample });
    expect(byOrganizer.html).toContain('This one&rsquo;s been called off.');
    expect(byOrganizer.html).toContain('About your refund');
    expect(byOrganizer.html).toContain('Refunds for a cancelled event are issued by');

    const byCustomer = renderDesign(d, { ...base, byCustomer: true, refundText: '₹798' });
    expect(byCustomer.html).toContain('as you asked');
    expect(byCustomer.html).toContain('Your refund is on its way');
    expect(byCustomer.html).toContain('Refund due');

    const byVenue = renderDesign(d, { ...base, refundText: '₹500', refundAtVenue: true });
    expect(byVenue.html).toContain('has cancelled your booking at');
    expect(byVenue.html).toContain('returned to you at the venue');
    expect(byVenue.html).not.toContain('About your refund');
  });

  it('listing needs changes: bullets, or a fallback when no reason was given', () => {
    const d = getEmailDesign('listing.rejected')!;
    const withFixes = renderDesign(d, { ...shared, ...d.sample });
    expect(withFixes.html).toContain('Add a meeting point');
    expect(withFixes.html).toContain('Questions? Just reply to this email.');
    const noFixes = renderDesign(d, { ...shared, ...d.sample, fixes: [], canReply: false });
    expect(noFixes.html).toContain('The reviewer didn&rsquo;t add details.');
    expect(noFixes.html).not.toContain('reply to this email');
  });

  it('escapes customer- and partner-supplied text in the HTML', () => {
    const d = getEmailDesign('partner.booking_confirmed')!;
    const out = renderDesign(d, { ...shared, ...d.sample, customerFirst: '<script>x</script>' });
    expect(out.html).not.toContain('<script>x</script>');
    expect(out.html).toContain('&lt;script&gt;');
  });

  it('each MSG91 slug is the one MSG91 derives from the design name', async () => {
    const { msg91SlugFromName } = await import('./index.js');
    for (const d of EMAIL_DESIGNS.filter((x) => x.msg91Slug)) {
      expect(d.msg91Slug).toBe(msg91SlugFromName(d.name));
    }
  });

  it('every MSG91 slug is unique and admin designs have none', () => {
    const slugs = EMAIL_DESIGNS.flatMap((d) => (d.msg91Slug ? [d.msg91Slug] : []));
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs).toHaveLength(6);
    for (const d of EMAIL_DESIGNS.filter((x) => x.key.startsWith('admin.'))) expect(d.msg91Slug).toBeUndefined();
  });

  it('renderEmail falls back to the plain template for keys without a design', () => {
    const out = renderEmail('tenant.invitation', {
      tenantName: 'Tigers Co',
      inviterName: 'Olivia',
      role: 'manager',
      inviteUrl: 'https://partners.circls.app/invite/x',
      expiresAtIso: '2026-11-01',
    });
    expect(out.html).toBeUndefined();
    expect(out.subject).toBe("You've been invited to join Tigers Co");
  });
});

describe('msg91TemplateId — a design uses its own template only once switched on', () => {
  afterEach(() => {
    vi.resetModules();
  });

  async function load(envValue: Record<string, unknown>) {
    vi.doMock('../../../config/env.js', () => ({ env: { MSG91_EMAIL_TEMPLATES: {}, MSG91_EMAIL_DESIGNS: [], ...envValue } }));
    return import('./index.js');
  }

  it('is off by default: every email uses the generic template', async () => {
    const { msg91TemplateId } = await load({});
    expect(msg91TemplateId('booking.confirmed')).toBeUndefined();
  });

  it('switches on per key, or all at once', async () => {
    let m = await load({ MSG91_EMAIL_DESIGNS: ['booking.confirmed'] });
    expect(m.msg91TemplateId('booking.confirmed')).toBe('circls_booking_confirmed_v2');
    expect(m.msg91TemplateId('listing.approved')).toBeUndefined();
    vi.resetModules();
    m = await load({ MSG91_EMAIL_DESIGNS: ['all'] });
    expect(m.msg91TemplateId('listing.approved')).toBe('circls_partner_listing_approved_v2');
    // Admin designs never have an MSG91 template of their own.
    expect(m.msg91TemplateId('admin.org_signup')).toBeUndefined();
  });

  it('an explicit slug mapping wins and counts as switched on', async () => {
    const { msg91TemplateId } = await load({ MSG91_EMAIL_TEMPLATES: { 'booking.confirmed': 'my_slug' } });
    expect(msg91TemplateId('booking.confirmed')).toBe('my_slug');
  });
});
