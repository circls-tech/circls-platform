#!/usr/bin/env node
// Post-deploy smoke: wait for live /v1/health build SHA to equal EXPECTED_SHA (bounded),
// then GET each PORTAL_URLS entry and assert < 400. Pure SHA-match logic is unit-tested in
// lib.test.mjs (healthShaMatches); this is the I/O wrapper.
//   Env: HEALTH_URL, EXPECTED_SHA, PORTAL_URLS (comma-sep),
//        HEALTH_TIMEOUT_S (default 600), POLL_INTERVAL_S (default 10)
import { healthShaMatches } from './lib.mjs';

const HEALTH_URL = process.env.HEALTH_URL ?? 'https://api.circls.app/v1/health';
const EXPECTED_SHA = process.env.EXPECTED_SHA ?? '';
const PORTAL_URLS = (process.env.PORTAL_URLS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const TIMEOUT_S = Number(process.env.HEALTH_TIMEOUT_S ?? '600');
const INTERVAL_S = Number(process.env.POLL_INTERVAL_S ?? '10');

async function getText(url) {
  const res = await fetch(url, { redirect: 'follow' });
  return { status: res.status, body: await res.text() };
}

async function waitForHealth() {
  if (!EXPECTED_SHA) {
    console.log('No EXPECTED_SHA — skipping build-SHA wait.');
    return;
  }
  const deadline = Date.now() + TIMEOUT_S * 1000;
  for (;;) {
    let body = '';
    try {
      ({ body } = await getText(HEALTH_URL));
    } catch (e) {
      body = '';
      console.log(`health fetch error: ${e.message}`);
    }
    if (body) console.log(`health: ${body.slice(0, 120)}`);
    if (healthShaMatches(body, EXPECTED_SHA)) {
      console.log(`✓ live build SHA matches ${EXPECTED_SHA.slice(0, 7)}`);
      return;
    }
    if (Date.now() > deadline) {
      console.error(`✗ timed out after ${TIMEOUT_S}s waiting for ${EXPECTED_SHA.slice(0, 7)}`);
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, INTERVAL_S * 1000));
  }
}

async function probePortals() {
  let failed = 0;
  for (const url of PORTAL_URLS) {
    try {
      const { status } = await getText(url);
      const ok = status < 400;
      console.log(`${ok ? '✓' : '✗'} ${url} → ${status}`);
      if (!ok) failed += 1;
    } catch (e) {
      console.log(`✗ ${url} → ${e.message}`);
      failed += 1;
    }
  }
  if (failed) {
    console.error(`${failed} portal probe(s) failed.`);
    process.exit(1);
  }
}

await waitForHealth();
await probePortals();
console.log('✅ Smoke passed.');
