import { describe, expect, it } from 'vitest';
import { inferSport } from './sport_inference.js';

describe('inferSport', () => {
  it.each([
    // football
    ['football', 'football'],
    ['FOOTBALL', 'football'],
    ['5-a-side', 'football'],
    ['7-a-side', 'football'],
    ['soccer', 'football'],
    // cricket
    ['cricket', 'cricket'],
    ['net', 'cricket'],
    ['nets', 'cricket'],
    // badminton
    ['badminton', 'badminton'],
    ['shuttle', 'badminton'],
    // tennis
    ['tennis', 'tennis'],
    // basketball
    ['basketball', 'basketball'],
    ['hoops', 'basketball'],
    // swimming
    ['swimming', 'swimming'],
    ['pool', 'swimming'],
    // table-tennis
    ['table-tennis', 'table-tennis'],
    ['tt', 'table-tennis'],
    ['ping-pong', 'table-tennis'],
    // squash
    ['squash', 'squash'],
    // kabaddi
    ['kabaddi', 'kabaddi'],
    // pickleball
    ['pickleball', 'pickleball'],
  ])('tag %s → sport %s', (tag, expected) => {
    expect(inferSport([tag])).toBe(expected);
  });

  it('returns null when no tags match', () => {
    expect(inferSport([])).toBeNull();
    expect(inferSport(['xyz', 'foo'])).toBeNull();
    expect(inferSport([''])).toBeNull();
  });

  it('returns the first matched sport when multiple tags present', () => {
    // tennis comes before swimming alphabetically but football is first in list
    expect(inferSport(['football', 'tennis'])).toBe('football');
    expect(inferSport(['tennis', 'football'])).toBe('tennis');
  });

  it('handles whitespace around tags', () => {
    expect(inferSport(['  cricket  '])).toBe('cricket');
    expect(inferSport([' BADMINTON '])).toBe('badminton');
  });

  it('first-match-wins when multiple sports inferred', () => {
    expect(inferSport(['nets', 'pool'])).toBe('cricket');
    expect(inferSport(['pool', 'nets'])).toBe('swimming');
  });
});
