/** Walks `err` and its `.cause` chain (Drizzle wraps the underlying pg error). */
function hasPgCode(err: unknown, code: string): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; cause?: unknown };
  if (e.code === code) return true;
  return hasPgCode(e.cause, code);
}

/** Postgres unique-violation (SQLSTATE 23505). */
export function isUniqueViolation(err: unknown): boolean {
  return hasPgCode(err, '23505');
}

/** Postgres exclusion-violation (SQLSTATE 23P01) — e.g. the booking GIST constraint. */
export function isExclusionViolation(err: unknown): boolean {
  return hasPgCode(err, '23P01');
}
