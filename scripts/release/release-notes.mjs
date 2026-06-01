#!/usr/bin/env node
// Print the release-candidate markdown for the commit range <base>..<head>.
// Usage: node scripts/release/release-notes.mjs <base-ref> <head-ref>
import { execFileSync } from 'node:child_process';
import { parseChangedFiles, detectMigrations, parseCommits, formatReleaseNotes } from './lib.mjs';

const [base, head] = process.argv.slice(2);
if (!base || !head) {
  console.error('usage: release-notes.mjs <base-ref> <head-ref>');
  process.exit(2);
}
const git = (args) => execFileSync('git', args, { encoding: 'utf8' });
const commits = parseCommits(git(['log', '--format=%H%x09%s', `${base}..${head}`]));
const migrations = detectMigrations(parseChangedFiles(git(['diff', '--name-only', `${base}..${head}`])));
process.stdout.write(formatReleaseNotes({ baseSha: base, headSha: head, commits, migrations }) + '\n');
