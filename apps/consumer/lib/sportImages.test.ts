import { describe, expect, it } from 'vitest';
import { resolveImage, matchSport } from './sportImages';

describe('matchSport', () => {
  it('matches a canonical tag case-insensitively', () => {
    expect(matchSport(['Badminton'])).toBe('badminton');
  });
  it('folds aliases (soccer → football)', () => {
    expect(matchSport(['Soccer'])).toBe('football');
  });
  it('normalizes whitespace and punctuation', () => {
    expect(matchSport(['Table Tennis'])).toBe('tableTennis');
    expect(matchSport(['5-a-side'])).toBe('football');
  });
  it('returns null when nothing matches', () => {
    expect(matchSport(['Yoga'])).toBeNull();
    expect(matchSport([])).toBeNull();
    expect(matchSport(undefined)).toBeNull();
  });
  it('returns the first matching tag in order', () => {
    expect(matchSport(['yoga', 'tennis'])).toBe('tennis');
    expect(matchSport(['tennis', 'badminton'])).toBe('tennis');
  });
});

describe('resolveImage', () => {
  it('returns a self-hosted photo for a matched tag', () => {
    const r = resolveImage({ tags: ['tennis'] });
    expect(r).toEqual({ kind: 'photo', src: '/sports/tennis.jpg', sport: 'tennis' });
  });
  it('prefers an uploaded imageUrl over the tag image', () => {
    const r = resolveImage({ imageUrl: 'https://cdn/x.jpg', tags: ['tennis'] });
    expect(r).toEqual({ kind: 'photo', src: 'https://cdn/x.jpg', sport: 'tennis' });
  });
  it('falls back to the motif when no tag matches and no upload', () => {
    expect(resolveImage({ tags: ['yoga'] })).toEqual({ kind: 'motif' });
    expect(resolveImage({})).toEqual({ kind: 'motif' });
  });
  it('uses the uploaded imageUrl even when no tag matches (no sport field)', () => {
    expect(resolveImage({ imageUrl: 'https://cdn/x.jpg' })).toEqual({ kind: 'photo', src: 'https://cdn/x.jpg' });
  });
});
