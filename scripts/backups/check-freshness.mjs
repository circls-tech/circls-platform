#!/usr/bin/env node
// Reads `aws s3api list-objects-v2 --output json` from stdin, asserts the newest
// backup is < MAX_AGE_HOURS old. Exits 1 (and prints a clear message) if stale.
// Usage: aws s3api list-objects-v2 ... --output json | node check-freshness.mjs
import { isStale, parseNewest } from './freshness.mjs';

const MAX_AGE_HOURS = Number(process.env.MAX_AGE_HOURS ?? '24');
if (!Number.isFinite(MAX_AGE_HOURS) || MAX_AGE_HOURS <= 0) {
  console.error(`CONFIG ERROR: MAX_AGE_HOURS must be a positive number, got: ${process.env.MAX_AGE_HOURS}`);
  process.exit(2);
}

let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;

let newest;
try {
  newest = parseNewest(input || '{}');
} catch (e) {
  console.error(`ERROR: could not parse S3 response: ${e.message}`);
  process.exit(2);
}
const now = Date.now();

if (isStale(newest, now, MAX_AGE_HOURS)) {
  console.error(
    `STALE: newest backup is ${newest ?? 'MISSING'} — older than ${MAX_AGE_HOURS}h threshold.`,
  );
  process.exit(1);
}
console.log(`OK: newest backup ${newest} is within ${MAX_AGE_HOURS}h.`);
