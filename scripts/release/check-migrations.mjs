#!/usr/bin/env node
// Validates drizzle migration numbering + journal consistency. Catches the
// parallel-agent collision hazard (two branches grabbing the same NNNN). Tolerates
// intentional gaps (e.g. 0014 was skipped); rejects duplicates, file/journal
// mismatches, orphans on either side, and non-increasing "when".
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

/** @returns {{ok: boolean, errors: string[]}} */
export function checkMigrations(sqlFiles, journal) {
  const errors = [];
  const pad = (n) => String(n).padStart(4, '0');

  const parsed = sqlFiles
    .filter((f) => f.endsWith('.sql'))
    .map((f) => {
      const m = f.match(/^(\d{4})_(.+)\.sql$/);
      return m ? { num: Number(m[1]), tag: `${m[1]}_${m[2]}`, file: f } : { invalid: f };
    });
  for (const p of parsed) {
    if (p.invalid) errors.push(`migration file does not match NNNN_name.sql: ${p.invalid}`);
  }
  const files = parsed.filter((p) => !p.invalid);

  const byNum = new Map();
  for (const f of files) {
    if (byNum.has(f.num)) {
      errors.push(`duplicate migration number ${pad(f.num)}: ${byNum.get(f.num)} and ${f.file}`);
    } else {
      byNum.set(f.num, f.file);
    }
  }

  const entries = Array.isArray(journal?.entries) ? journal.entries : [];
  const byIdx = new Map();
  for (const e of entries) {
    if (byIdx.has(e.idx)) errors.push(`duplicate _journal idx ${e.idx}`);
    else byIdx.set(e.idx, e);
  }

  for (const f of files) {
    const e = byIdx.get(f.num);
    if (!e) errors.push(`migration ${f.file} has no _journal entry (idx ${f.num})`);
    else if (e.tag !== f.tag) errors.push(`_journal idx ${f.num} tag "${e.tag}" != file tag "${f.tag}"`);
  }
  for (const e of entries) {
    if (!byNum.has(e.idx)) errors.push(`_journal entry idx ${e.idx} (tag "${e.tag}") has no matching .sql file`);
  }

  const sorted = [...entries].sort((a, b) => a.idx - b.idx);
  for (let i = 1; i < sorted.length; i++) {
    if (!(sorted[i].when > sorted[i - 1].when)) {
      errors.push(
        `_journal "when" not strictly increasing: idx ${sorted[i - 1].idx} (${sorted[i - 1].when}) >= idx ${sorted[i].idx} (${sorted[i].when})`,
      );
    }
  }
  return { ok: errors.length === 0, errors };
}

// CLI entrypoint: validate the real repo migrations.
if (import.meta.url === `file://${process.argv[1]}`) {
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = join(here, '..', '..', 'apps', 'api', 'src', 'db', 'migrations');
  const files = readdirSync(dir);
  const journal = JSON.parse(readFileSync(join(dir, 'meta', '_journal.json'), 'utf8'));
  const { ok, errors } = checkMigrations(files, journal);
  if (!ok) {
    console.error('Migration check FAILED:');
    for (const e of errors) console.error('  - ' + e);
    process.exit(1);
  }
  console.log(`Migration check OK: ${files.filter((f) => f.endsWith('.sql')).length} migrations, journal consistent.`);
}
