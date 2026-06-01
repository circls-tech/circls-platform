#!/usr/bin/env node
// Print (newline-separated) the migration SQL files changed in <base>..<head>, or nothing.
// Usage: node scripts/release/detect-migrations.mjs <base-ref> <head-ref>
import { execFileSync } from 'node:child_process';
import { parseChangedFiles, detectMigrations } from './lib.mjs';

const [base, head] = process.argv.slice(2);
if (!base || !head) {
  console.error('usage: detect-migrations.mjs <base-ref> <head-ref>');
  process.exit(2);
}
const out = execFileSync('git', ['diff', '--name-only', `${base}..${head}`], { encoding: 'utf8' });
for (const m of detectMigrations(parseChangedFiles(out))) console.log(m);
