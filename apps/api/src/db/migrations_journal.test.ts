import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The hand-kept migration journal (meta/_journal.json) stays consistent.
 *
 * Migrations are numbered by hand, so two branches routinely each add "the
 * next one". Git flags the clash in the journal, but the fix is easy to get
 * half right: renaming the second file to the next number while keeping its
 * `when`. Drizzle applies a migration only when its `when` is newer than the
 * last one the database applied, so that entry is then skipped, silently, on
 * every database that already ran the other branch's migration. These checks
 * fail the merge instead.
 */
interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

const migrationsDir = fileURLToPath(new URL('./migrations/', import.meta.url));
const entries = (
  JSON.parse(readFileSync(`${migrationsDir}meta/_journal.json`, 'utf8')) as { entries: JournalEntry[] }
).entries;

/**
 * Shipped long ago with the same `when` as the entry before it; every
 * database has applied both. Nothing new may join this list.
 */
const HISTORICAL_SAME_WHEN = new Set(['0017_events_org_scoped']);

describe('migration journal', () => {
  it('numbers entries in increasing order, each number used once, tags to match', () => {
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i]!.idx, `${entries[i]!.tag} after ${entries[i - 1]!.tag}`).toBeGreaterThan(entries[i - 1]!.idx);
    }
    for (const e of entries) {
      expect(e.tag.startsWith(`${String(e.idx).padStart(4, '0')}_`), e.tag).toBe(true);
    }
  });

  it('gives every entry a later `when` than the one before it', () => {
    for (let i = 1; i < entries.length; i++) {
      const prev = entries[i - 1]!;
      const cur = entries[i]!;
      if (HISTORICAL_SAME_WHEN.has(cur.tag)) continue;
      expect(cur.when, `${cur.tag} must be newer than ${prev.tag} or Drizzle skips it`).toBeGreaterThan(prev.when);
    }
  });

  it('has a .sql file for every entry and an entry for every .sql file', () => {
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => f.slice(0, -'.sql'.length))
      .sort();
    expect(files).toEqual(entries.map((e) => e.tag).sort());
  });
});
