#!/usr/bin/env node
// Reads `aws s3api list-objects-v2 --output json` from stdin, asserts the newest
// backup is < MAX_AGE_HOURS old. Exits 1 (and prints a clear message) if stale.
// Usage: aws s3api list-objects-v2 ... --output json | node check-freshness.mjs
import { isStale, parseNewest } from './freshness.mjs';

const MAX_AGE_HOURS = Number(process.env.MAX_AGE_HOURS ?? '24');

let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;

const newest = parseNewest(input || '{}');
const now = Date.now();

if (isStale(newest, now, MAX_AGE_HOURS)) {
  console.error(
    `STALE: newest backup is ${newest ?? 'MISSING'} — older than ${MAX_AGE_HOURS}h threshold.`,
  );
  process.exit(1);
}
console.log(`OK: newest backup ${newest} is within ${MAX_AGE_HOURS}h.`);
