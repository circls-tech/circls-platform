// Pure helpers shared by the release CLIs. No external deps — node-only, so they run
// identically in CI, on the droplet, and locally. The I/O (git, fetch, gh) lives in the
// thin CLI wrappers; everything decision-shaped lives here and is unit-tested in lib.test.mjs.

const MIGRATIONS_PREFIX = 'apps/api/src/db/migrations/';

/** Split `git diff --name-only` / `git log --name-only` output into trimmed, non-empty paths. */
export function parseChangedFiles(text) {
  return String(text)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Migration SQL files among the changed files (the parallel-agent-collision-prone area). */
export function detectMigrations(changedFiles) {
  return changedFiles.filter(
    (f) => f.startsWith(MIGRATIONS_PREFIX) && f.endsWith('.sql'),
  );
}

/** Parse `git log --format=%H%x09%s` into [{ sha, subject }]. */
export function parseCommits(text) {
  return String(text)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const tab = l.indexOf('\t');
      return tab === -1
        ? { sha: l, subject: '' }
        : { sha: l.slice(0, tab), subject: l.slice(tab + 1) };
    });
}

/** Render the release-candidate / release-notes markdown body. */
export function formatReleaseNotes({ baseSha, headSha, commits, migrations }) {
  const lines = [`### Release candidate: \`${short(baseSha)}\` → \`${short(headSha)}\``, ''];
  if (commits.length === 0) {
    lines.push('_No new commits — `release` is already at `main`. Nothing to ship._');
    return lines.join('\n');
  }
  lines.push(`**${commits.length} commit(s) would ship:**`, '');
  for (const c of commits) lines.push(`- \`${short(c.sha)}\` ${c.subject}`);
  lines.push('');
  if (migrations.length > 0) {
    lines.push(`> ⚠️ **${migrations.length} migration(s) in this batch** — schema changes run on deploy:`);
    for (const m of migrations) lines.push(`> - \`${m}\``);
  } else {
    lines.push('_No database migrations in this batch._');
  }
  return lines.join('\n');
}

function short(sha) {
  return String(sha).slice(0, 7);
}

/** True if the live /v1/health commit matches expected (prefix-tolerant, case-insensitive). */
export function healthShaMatches(healthJson, expectedSha) {
  const data = typeof healthJson === 'string' ? safeParse(healthJson) : healthJson;
  const actual = data && typeof data.commit === 'string' ? data.commit.toLowerCase() : '';
  const expected = String(expectedSha ?? '').toLowerCase();
  if (!actual || !expected || expected.length < 7) return false;
  return actual.startsWith(expected) || expected.startsWith(actual);
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Given GitHub check-runs JSON and required check names, report whether all passed. */
export function allChecksPassed(checkRunsJson, requiredNames) {
  if (!Array.isArray(requiredNames) || requiredNames.length === 0) {
    return { ok: false, details: [] };
  }
  const data = typeof checkRunsJson === 'string' ? safeParse(checkRunsJson) : checkRunsJson;
  const runs = data && Array.isArray(data.check_runs) ? data.check_runs : [];
  const byName = new Map();
  for (const r of runs) {
    // check-runs come back newest-first; keep the first (newest) seen per name.
    if (!byName.has(r.name)) byName.set(r.name, r);
  }
  const details = requiredNames.map((name) => {
    const run = byName.get(name);
    const ok = !!run && run.status === 'completed' && run.conclusion === 'success';
    return { name, ok, status: run?.status ?? null, conclusion: run?.conclusion ?? null };
  });
  return { ok: details.every((d) => d.ok), details };
}

/** Next `release-<date>.N` tag given existing tag names and an ISO date (YYYY-MM-DD). */
export function nextReleaseTag(existingTags, dateStr) {
  const prefix = `release-${dateStr}.`;
  let max = 0;
  for (const t of existingTags) {
    if (typeof t === 'string' && t.startsWith(prefix)) {
      const suffix = t.slice(prefix.length);
      if (/^\d+$/.test(suffix)) {
        const n = Number(suffix);
        if (n > max) max = n;
      }
    }
  }
  return `${prefix}${max + 1}`;
}
