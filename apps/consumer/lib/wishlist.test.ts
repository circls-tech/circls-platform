import { describe, expect, it } from 'vitest';
import { EMPTY_WISHLIST_IDS, isLiked, withLike } from './wishlist';

describe('wishlist ids', () => {
  const ids = { events: ['e1'], memberships: [], venues: ['v1', 'v2'] };

  it('isLiked reads the right bucket and treats a missing cache as not liked', () => {
    expect(isLiked(ids, 'event', 'e1')).toBe(true);
    expect(isLiked(ids, 'venue', 'v2')).toBe(true);
    expect(isLiked(ids, 'membership', 'e1')).toBe(false);
    expect(isLiked(undefined, 'event', 'e1')).toBe(false);
  });

  it('withLike adds to the front without duplicating', () => {
    expect(withLike(ids, 'venue', 'v3', true).venues).toEqual(['v3', 'v1', 'v2']);
    expect(withLike(ids, 'venue', 'v2', true).venues).toEqual(['v2', 'v1']);
    expect(withLike(undefined, 'membership', 'm1', true)).toEqual({
      ...EMPTY_WISHLIST_IDS,
      memberships: ['m1'],
    });
  });

  it('withLike removes idempotently and never mutates its input', () => {
    const next = withLike(ids, 'event', 'e1', false);
    expect(next.events).toEqual([]);
    expect(withLike(ids, 'event', 'nope', false)).toEqual(ids);
    expect(ids.events).toEqual(['e1']);
    expect(next.venues).toBe(ids.venues);
  });
});
