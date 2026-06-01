#!/usr/bin/env node
// Gate: read `gh api repos/{repo}/commits/{sha}/check-runs` JSON on stdin and exit non-zero
// unless every REQUIRED_CHECKS entry is completed+success. Usage:
//   gh api repos/$REPO/commits/$SHA/check-runs | REQUIRED_CHECKS=verify,db node check-ci.mjs
import { allChecksPassed } from './lib.mjs';

const required = (process.env.REQUIRED_CHECKS ?? 'verify,db')
  .split(',').map((s) => s.trim()).filter(Boolean);

let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;

const { ok, details } = allChecksPassed(input || '{}', required);
for (const d of details) {
  console.log(`${d.ok ? '✓' : '✗'} ${d.name}: ${d.status ?? 'missing'}/${d.conclusion ?? '-'}`);
}
if (!ok) {
  console.error('CI is not green on the target SHA — refusing to release.');
  process.exit(1);
}
console.log('All required checks are green.');
