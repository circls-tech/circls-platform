#!/usr/bin/env node
// Compute the next `release-<DATE>.N` tag. Reads existing tags (e.g. `git tag -l`) on stdin;
// DATE env must be YYYY-MM-DD. Usage: git tag -l | DATE=2026-06-01 node release-tag.mjs
import { nextReleaseTag } from './lib.mjs';

const date = process.env.DATE;
if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error('DATE env (YYYY-MM-DD) is required');
  process.exit(2);
}
let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
const tags = input.split('\n').map((s) => s.trim()).filter(Boolean);
process.stdout.write(nextReleaseTag(tags, date) + '\n');
