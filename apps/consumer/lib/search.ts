/**
 * Search bar state ↔ URL. The search page lives at `/search?q=…&type=…` so a
 * result list can be shared, refreshed and stepped back to.
 */

export const SEARCH_TYPES = ['event', 'venue', 'membership'] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

/** Which sections to show: everything, or one kind of listing. */
export type SearchScope = 'all' | SearchType;

export const SCOPE_LABELS: Record<SearchScope, string> = {
  all: 'All',
  event: 'Events',
  venue: 'Venues',
  membership: 'Memberships',
};

/** Longest term the API accepts (`q` max length). */
export const SEARCH_QUERY_MAX = 120;

/** Trim, collapse whitespace and cap the term. Empty → ''. */
export function normaliseQuery(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\s+/g, ' ').trim().slice(0, SEARCH_QUERY_MAX);
}

/** The scope from a `type` param; anything unknown means everything. */
export function parseScope(raw: string | null | undefined): SearchScope {
  return (SEARCH_TYPES as readonly string[]).includes(raw ?? '') ? (raw as SearchType) : 'all';
}

/** `/search?q=…[&type=…]` — the scope is omitted when it is everything. */
export function searchHref(q: string, scope: SearchScope = 'all'): string {
  const qs = new URLSearchParams();
  const term = normaliseQuery(q);
  if (term) qs.set('q', term);
  if (scope !== 'all') qs.set('type', scope);
  const s = qs.toString();
  return s ? `/search?${s}` : '/search';
}
