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

/** Name of the violated constraint for a unique-violation, or null. Lets callers
 * tell which of several UNIQUE constraints on a table fired. */
export function uniqueViolationConstraint(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null;
  const e = err as {
    code?: unknown;
    constraint?: unknown; // node-postgres
    constraint_name?: unknown; // postgres-js
    cause?: unknown;
  };
  if (e.code === '23505') {
    if (typeof e.constraint === 'string') return e.constraint;
    if (typeof e.constraint_name === 'string') return e.constraint_name;
  }
  return uniqueViolationConstraint(e.cause);
}

/** Postgres exclusion-violation (SQLSTATE 23P01) — e.g. the booking GIST constraint. */
export function isExclusionViolation(err: unknown): boolean {
  return hasPgCode(err, '23P01');
}
