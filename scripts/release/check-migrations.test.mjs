import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { checkMigrations } from './check-migrations.mjs';

const j = (entries) => ({ version: '7', dialect: 'postgresql', entries });

test('valid with an intentional gap is OK (mirrors real 0014-skipped state)', () => {
  const files = ['0000_a.sql', '0002_b.sql'];
  const journal = j([
    { idx: 0, tag: '0000_a', when: 1 },
    { idx: 2, tag: '0002_b', when: 2 },
  ]);
  const r = checkMigrations(files, journal);
  assert.equal(r.ok, true, r.errors.join('; '));
});

test('duplicate migration number is rejected (the parallel-agent hazard)', () => {
  const files = ['0001_a.sql', '0001_b.sql'];
  const journal = j([{ idx: 1, tag: '0001_a', when: 1 }]);
  const r = checkMigrations(files, journal);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /duplicate migration number 0001/);
});

test('tag mismatch between file and journal is rejected', () => {
  const files = ['0001_a.sql'];
  const journal = j([{ idx: 1, tag: '0001_renamed', when: 1 }]);
  const r = checkMigrations(files, journal);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /tag/);
});

test('a .sql file with no journal entry is rejected', () => {
  const files = ['0000_a.sql', '0001_b.sql'];
  const journal = j([{ idx: 0, tag: '0000_a', when: 1 }]);
  const r = checkMigrations(files, journal);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /no _journal entry/);
});

test('a journal entry with no .sql file is rejected', () => {
  const files = ['0000_a.sql'];
  const journal = j([
    { idx: 0, tag: '0000_a', when: 1 },
    { idx: 1, tag: '0001_ghost', when: 2 },
  ]);
  const r = checkMigrations(files, journal);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /no matching \.sql/);
});

test('non-increasing "when" is rejected', () => {
  const files = ['0000_a.sql', '0001_b.sql'];
  const journal = j([
    { idx: 0, tag: '0000_a', when: 5 },
    { idx: 1, tag: '0001_b', when: 3 },
  ]);
  const r = checkMigrations(files, journal);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /strictly increasing/);
});

test('malformed filename is rejected', () => {
  const r = checkMigrations(['001_bad.sql'], j([]));
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /NNNN_name\.sql/);
});

test('the REAL repo migrations pass the check', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = join(here, '..', '..', 'apps', 'api', 'src', 'db', 'migrations');
  const files = readdirSync(dir);
  const journal = JSON.parse(readFileSync(join(dir, 'meta', '_journal.json'), 'utf8'));
  const r = checkMigrations(files, journal);
  assert.equal(r.ok, true, r.errors.join('; '));
});
