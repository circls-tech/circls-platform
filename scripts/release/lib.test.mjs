import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseChangedFiles,
  detectMigrations,
  parseCommits,
  formatReleaseNotes,
  healthShaMatches,
  allChecksPassed,
  nextReleaseTag,
} from './lib.mjs';

test('parseChangedFiles: trims, drops blanks', () => {
  assert.deepEqual(parseChangedFiles('a.ts\n  b/c.sql \n\n'), ['a.ts', 'b/c.sql']);
});

test('detectMigrations: only .sql under the migrations dir', () => {
  const files = [
    'apps/api/src/db/migrations/0015_add_x.sql',
    'apps/api/src/db/migrations/meta/_journal.json',
    'apps/api/src/routes/consumer.ts',
    'apps/api/src/db/migrations/0016_y.sql',
  ];
  assert.deepEqual(detectMigrations(files), [
    'apps/api/src/db/migrations/0015_add_x.sql',
    'apps/api/src/db/migrations/0016_y.sql',
  ]);
});

test('parseCommits: splits sha<TAB>subject, tolerates no-tab line', () => {
  const out = `abc123\tfeat: a\ndef456\tfix: b\nnotab`;
  assert.deepEqual(parseCommits(out), [
    { sha: 'abc123', subject: 'feat: a' },
    { sha: 'def456', subject: 'fix: b' },
    { sha: 'notab', subject: '' },
  ]);
});

test('formatReleaseNotes: empty commits = nothing to ship', () => {
  const md = formatReleaseNotes({ baseSha: 'aaaaaaaa', headSha: 'aaaaaaaa', commits: [], migrations: [] });
  assert.match(md, /Nothing to ship/);
});

test('formatReleaseNotes: lists commits and flags migrations', () => {
  const md = formatReleaseNotes({
    baseSha: 'aaaaaaa0', headSha: 'bbbbbbb0',
    commits: [{ sha: 'bbbbbbb0', subject: 'feat: thing' }],
    migrations: ['apps/api/src/db/migrations/0017_z.sql'],
  });
  assert.match(md, /1 commit/);
  assert.match(md, /feat: thing/);
  assert.match(md, /1 migration/);
  assert.match(md, /0017_z\.sql/);
});

test('formatReleaseNotes: no migrations says so', () => {
  const md = formatReleaseNotes({
    baseSha: 'a', headSha: 'b',
    commits: [{ sha: 'b', subject: 's' }], migrations: [],
  });
  assert.match(md, /No database migrations/);
});

test('healthShaMatches: short prefix matches full, both directions', () => {
  assert.equal(healthShaMatches('{"ok":true,"commit":"abc1234def"}', 'abc1234'), true);
  assert.equal(healthShaMatches({ ok: true, commit: 'abc1234' }, 'abc1234def'), true);
});

test('healthShaMatches: mismatch / bad input is false', () => {
  assert.equal(healthShaMatches('{"ok":true,"commit":"abc1234"}', 'ffff999'), false);
  assert.equal(healthShaMatches('not json', 'abc'), false);
  assert.equal(healthShaMatches('{"ok":true}', 'abc'), false);
  assert.equal(healthShaMatches('{"commit":"abc"}', ''), false);
});

test('healthShaMatches: a too-short expected SHA never matches', () => {
  assert.equal(healthShaMatches('{"ok":true,"commit":"abc1234def"}', 'a'), false);
  assert.equal(healthShaMatches('{"ok":true,"commit":"abc1234def"}', 'abc12'), false);
});

test('allChecksPassed: all required green = ok', () => {
  const json = JSON.stringify({ check_runs: [
    { name: 'verify', status: 'completed', conclusion: 'success' },
    { name: 'db', status: 'completed', conclusion: 'success' },
  ] });
  const r = allChecksPassed(json, ['verify', 'db']);
  assert.equal(r.ok, true);
});

test('allChecksPassed: a failed check fails', () => {
  const json = JSON.stringify({ check_runs: [
    { name: 'verify', status: 'completed', conclusion: 'success' },
    { name: 'db', status: 'completed', conclusion: 'failure' },
  ] });
  assert.equal(allChecksPassed(json, ['verify', 'db']).ok, false);
});

test('allChecksPassed: a missing or in-progress check fails', () => {
  const missing = JSON.stringify({ check_runs: [
    { name: 'verify', status: 'completed', conclusion: 'success' },
  ] });
  assert.equal(allChecksPassed(missing, ['verify', 'db']).ok, false);
  const running = JSON.stringify({ check_runs: [
    { name: 'verify', status: 'completed', conclusion: 'success' },
    { name: 'db', status: 'in_progress', conclusion: null },
  ] });
  assert.equal(allChecksPassed(running, ['verify', 'db']).ok, false);
});

test('allChecksPassed: keeps the newest run per name (first wins)', () => {
  const json = JSON.stringify({ check_runs: [
    { name: 'db', status: 'completed', conclusion: 'success' },
    { name: 'db', status: 'completed', conclusion: 'failure' },
  ] });
  assert.equal(allChecksPassed(json, ['db']).ok, true);
});

test('allChecksPassed: empty requiredNames fails closed (misconfig, not vacuously green)', () => {
  assert.equal(allChecksPassed('{"check_runs":[{"name":"verify","status":"completed","conclusion":"success"}]}', []).ok, false);
});

// --- 3-state status field tests (success / failed / pending) ---

test('allChecksPassed: all required green → status success', () => {
  const json = JSON.stringify({ check_runs: [
    { name: 'verify', status: 'completed', conclusion: 'success' },
    { name: 'db', status: 'completed', conclusion: 'success' },
  ] });
  const r = allChecksPassed(json, ['verify', 'db']);
  assert.equal(r.status, 'success');
  assert.equal(r.ok, true);
});

test('allChecksPassed: completed non-success → status failed (abort immediately)', () => {
  const json = JSON.stringify({ check_runs: [
    { name: 'verify', status: 'completed', conclusion: 'success' },
    { name: 'db', status: 'completed', conclusion: 'failure' },
  ] });
  const r = allChecksPassed(json, ['verify', 'db']);
  assert.equal(r.status, 'failed');
  assert.equal(r.ok, false);
});

test('allChecksPassed: cancelled/timed_out conclusions → status failed', () => {
  const json = JSON.stringify({ check_runs: [
    { name: 'verify', status: 'completed', conclusion: 'cancelled' },
    { name: 'db', status: 'completed', conclusion: 'success' },
  ] });
  assert.equal(allChecksPassed(json, ['verify', 'db']).status, 'failed');
});

test('allChecksPassed: in_progress required check → status pending (wait, not abort)', () => {
  const json = JSON.stringify({ check_runs: [
    { name: 'verify', status: 'in_progress', conclusion: null },
    { name: 'db', status: 'completed', conclusion: 'success' },
  ] });
  const r = allChecksPassed(json, ['verify', 'db']);
  assert.equal(r.status, 'pending');
  assert.equal(r.ok, false);
});

test('allChecksPassed: queued required check → status pending', () => {
  const json = JSON.stringify({ check_runs: [
    { name: 'verify', status: 'queued', conclusion: null },
    { name: 'db', status: 'completed', conclusion: 'success' },
  ] });
  assert.equal(allChecksPassed(json, ['verify', 'db']).status, 'pending');
});

test('allChecksPassed: missing required check → status pending (not yet started)', () => {
  const json = JSON.stringify({ check_runs: [
    { name: 'db', status: 'completed', conclusion: 'success' },
  ] });
  assert.equal(allChecksPassed(json, ['verify', 'db']).status, 'pending');
});

test('allChecksPassed: failed check takes priority over pending (abort, do not wait)', () => {
  const json = JSON.stringify({ check_runs: [
    { name: 'verify', status: 'in_progress', conclusion: null },
    { name: 'db', status: 'completed', conclusion: 'failure' },
  ] });
  assert.equal(allChecksPassed(json, ['verify', 'db']).status, 'failed');
});

test('allChecksPassed: empty requiredNames → status failed (fail closed on misconfig)', () => {
  assert.equal(allChecksPassed('{"check_runs":[]}', []).status, 'failed');
});

test('allChecksPassed: detail entries carry result field', () => {
  const json = JSON.stringify({ check_runs: [
    { name: 'verify', status: 'completed', conclusion: 'success' },
    { name: 'db', status: 'in_progress', conclusion: null },
  ] });
  const { details } = allChecksPassed(json, ['verify', 'db']);
  assert.equal(details.find((d) => d.name === 'verify').result, 'success');
  assert.equal(details.find((d) => d.name === 'db').result, 'pending');
});

test('formatReleaseNotes: title reads "Pending release"', () => {
  const md = formatReleaseNotes({
    baseSha: 'aaaaaaa0', headSha: 'bbbbbbb0',
    commits: [{ sha: 'bbbbbbb0', subject: 'feat: thing' }], migrations: [],
  });
  assert.match(md, /### Pending release:/);
  assert.doesNotMatch(md, /Release candidate/);
});

test('nextReleaseTag: first of the day is .1', () => {
  assert.equal(nextReleaseTag([], '2026-06-01'), 'release-2026-06-01.1');
});

test('nextReleaseTag: increments past existing, ignores other dates/malformed', () => {
  const tags = [
    'release-2026-06-01.1',
    'release-2026-06-01.2',
    'release-2026-05-31.9',
    'release-2026-06-01.bogus',
    'lkg',
  ];
  assert.equal(nextReleaseTag(tags, '2026-06-01'), 'release-2026-06-01.3');
});

test('nextReleaseTag: ignores scientific-notation / padded suffixes', () => {
  const tags = ['release-2026-06-01.1', 'release-2026-06-01.2e3', 'release-2026-06-01. 5'];
  assert.equal(nextReleaseTag(tags, '2026-06-01'), 'release-2026-06-01.2');
});
