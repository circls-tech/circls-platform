import { describe, expect, it } from 'vitest';
import { isEventOnShelf, isMembershipOnShelf, isVenueOnShelf } from './shelf';

describe('isVenueOnShelf', () => {
  it('keeps a venue that is live, or on its way there', () => {
    expect(isVenueOnShelf({ status: 'active' })).toBe(true);
    expect(isVenueOnShelf({ status: 'pending_review' })).toBe(true);
  });

  it('drops the ones a customer cannot reach', () => {
    expect(isVenueOnShelf({ status: 'rejected' })).toBe(false);
    expect(isVenueOnShelf({ status: 'suspended' })).toBe(false);
    // Not reachable from the venue enum today, but the type admits it, and a
    // status nobody has classified must not default to visible.
    expect(isVenueOnShelf({ status: 'inactive' })).toBe(false);
  });
});

describe('isEventOnShelf', () => {
  it('keeps a draft: the partner is still writing it', () => {
    expect(isEventOnShelf({ status: 'draft' })).toBe(true);
    expect(isEventOnShelf({ status: 'pending_review' })).toBe(true);
    expect(isEventOnShelf({ status: 'published' })).toBe(true);
  });

  it('keeps a completed event, whose guest list still matters', () => {
    expect(isEventOnShelf({ status: 'completed' })).toBe(true);
  });

  it('drops what was pulled before it could run', () => {
    expect(isEventOnShelf({ status: 'cancelled' })).toBe(false);
    expect(isEventOnShelf({ status: 'rejected' })).toBe(false);
  });
});

describe('isMembershipOnShelf', () => {
  it('keeps a plan that is selling, or waiting to', () => {
    expect(isMembershipOnShelf({ status: 'active' })).toBe(true);
    expect(isMembershipOnShelf({ status: 'pending_review' })).toBe(true);
  });

  it('drops a deactivated or rejected plan', () => {
    expect(isMembershipOnShelf({ status: 'inactive' })).toBe(false);
    expect(isMembershipOnShelf({ status: 'rejected' })).toBe(false);
    // As above: the membership enum has no suspended row yet, the type does.
    expect(isMembershipOnShelf({ status: 'suspended' })).toBe(false);
  });
});
