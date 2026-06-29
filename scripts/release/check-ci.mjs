#!/usr/bin/env node
// Gate: read `gh api repos/{repo}/commits/{sha}/check-runs` JSON on stdin.
// Exit codes:
//   0 = all required checks completed/success  → proceed with release
//   1 = a required check completed non-success → abort immediately (won't recover)
//   2 = required check(s) still queued/in_progress/missing → caller should wait and retry
//
// Usage:
//   gh api repos/$REPO/commits/$SHA/check-runs | REQUIRED_CHECKS=verify,db node check-ci.mjs
import { allChecksPassed } from './lib.mjs';

const required = (process.env.REQUIRED_CHECKS ?? 'verify,db')
  .split(',').map((s) => s.trim()).filter(Boolean);

let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;

const { status, details } = allChecksPassed(input || '{}', required);
for (const d of details) {
  const icon = d.result === 'success' ? '✓' : d.result === 'failed' ? '✗' : '…';
  console.log(`${icon} ${d.name}: ${d.status ?? 'missing'}/${d.conclusion ?? '-'}`);
}

if (status === 'success') {
  console.log('All required checks are green.');
  process.exit(0);
} else if (status === 'failed') {
  console.error('A required check has failed — refusing to release.');
  process.exit(1);
} else {
  // status === 'pending': one or more required checks are still in progress/queued
  console.log('Required checks are still in progress — waiting...');
  process.exit(2);
}
