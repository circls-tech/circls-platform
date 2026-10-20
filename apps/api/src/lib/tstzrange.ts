/**
 * Postgres `tstzrange` text — `["2026-10-20 10:00:00+00","2026-10-20 11:00:00+00")`,
 * quotes optional, either bound possibly empty (unbounded) — as instants.
 * A bound that is missing or unparseable comes back null.
 */
export function parseTstzRange(range: string | null | undefined): { start: Date | null; end: Date | null } {
  const m = range ? /^[[(]"?([^",)]*)"?,"?([^")\]]*)"?[\])]$/.exec(range) : null;
  const toDate = (s: string | undefined): Date | null => {
    if (!s) return null;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  return { start: toDate(m?.[1]), end: toDate(m?.[2]) };
}
