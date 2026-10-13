import { describe, expect, it } from 'vitest';
import { normaliseQuery, parseScope, searchHref, SEARCH_QUERY_MAX } from './search';

describe('search url state', () => {
  it('normaliseQuery trims, collapses whitespace and caps the length', () => {
    expect(normaliseQuery('  futsal   night ')).toBe('futsal night');
    expect(normaliseQuery(null)).toBe('');
    expect(normaliseQuery('x'.repeat(SEARCH_QUERY_MAX + 10))).toHaveLength(SEARCH_QUERY_MAX);
  });

  it('parseScope accepts the known types and falls back to everything', () => {
    expect(parseScope('event')).toBe('event');
    expect(parseScope('membership')).toBe('membership');
    expect(parseScope('arena')).toBe('all');
    expect(parseScope(null)).toBe('all');
  });

  it('searchHref encodes the term and omits an "all" scope', () => {
    expect(searchHref('turf park', 'all')).toBe('/search?q=turf+park');
    expect(searchHref(' 100% pass ', 'membership')).toBe('/search?q=100%25+pass&type=membership');
    expect(searchHref('', 'venue')).toBe('/search?type=venue');
    expect(searchHref('')).toBe('/search');
  });
});
