import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isStale, parseNewest } from './freshness.mjs';

test('isStale: fresh backup (1h old) is not stale at 24h threshold', () => {
  const now = Date.parse('2026-05-31T03:00:00Z');
  assert.equal(isStale('2026-05-31T02:00:00Z', now, 24), false);
});

test('isStale: old backup (25h old) is stale at 24h threshold', () => {
  const now = Date.parse('2026-05-31T03:00:00Z');
  assert.equal(isStale('2026-05-30T02:00:00Z', now, 24), true);
});

test('isStale: missing/empty timestamp is treated as stale', () => {
  const now = Date.parse('2026-05-31T03:00:00Z');
  assert.equal(isStale(null, now, 24), true);
  assert.equal(isStale('', now, 24), true);
});

test('parseNewest: picks the latest LastModified from list-objects-v2 JSON', () => {
  const json = JSON.stringify({
    Contents: [
      { Key: 'p/a.dmp', LastModified: '2026-05-30T02:00:00Z' },
      { Key: 'p/b.dmp', LastModified: '2026-05-31T02:00:00Z' },
    ],
  });
  assert.equal(parseNewest(json), '2026-05-31T02:00:00Z');
});

test('parseNewest: empty bucket yields null', () => {
  assert.equal(parseNewest(JSON.stringify({})), null);
  assert.equal(parseNewest(JSON.stringify({ Contents: [] })), null);
});

test('isStale: backup exactly at threshold age is not stale', () => {
  const now = Date.parse('2026-05-31T03:00:00Z');
  assert.equal(isStale('2026-05-30T03:00:00Z', now, 24), false);
});

test('isStale: unparseable timestamp is treated as stale', () => {
  const now = Date.parse('2026-05-31T03:00:00Z');
  assert.equal(isStale('not-a-date', now, 24), true);
});
