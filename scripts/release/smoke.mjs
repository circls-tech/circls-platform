#!/usr/bin/env node
// Post-deploy smoke: wait for live /v1/health build SHA to equal EXPECTED_SHA (bounded),
// then GET each PORTAL_URLS entry and assert < 400, retrying until they come up. Pure
// decision logic is unit-tested in lib.test.mjs (healthShaMatches, portalProbeOk); this is
// the I/O wrapper.
//   Env: HEALTH_URL, EXPECTED_SHA, PORTAL_URLS (comma-sep),
//        HEALTH_TIMEOUT_S (default 600), PORTAL_TIMEOUT_S (default 300),
//        POLL_INTERVAL_S (default 10)
import { healthShaMatches, portalProbeOk } from './lib.mjs';

const HEALTH_URL = process.env.HEALTH_URL ?? 'https://api.circls.app/v1/health';
const EXPECTED_SHA = process.env.EXPECTED_SHA ?? '';
const PORTAL_URLS = (process.env.PORTAL_URLS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const TIMEOUT_S = Number(process.env.HEALTH_TIMEOUT_S ?? '600');
const PORTAL_TIMEOUT_S = Number(process.env.PORTAL_TIMEOUT_S ?? '300');
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

/** One attempt against one portal. A network error is reported like a bad status. */
async function probeOnce(url) {
  try {
    const { status } = await getText(url);
    return { url, ok: portalProbeOk(status), detail: String(status) };
  } catch (e) {
    return { url, ok: false, detail: e.message };
  }
}

/**
 * Probe every portal, retrying only the ones still failing, until they all pass
 * or PORTAL_TIMEOUT_S expires.
 *
 * WHY THE RETRY: the portals deploy independently of the API, so a portal can
 * still be rolling seconds after /v1/health reports the new build SHA. The
 * original single-shot probe failed the whole release on exactly that race — on
 * 2026-08-21 the API came up at 21:58:01 and circls.app was probed once at
 * 21:58:20, still returning 502. `release` had already been pushed and deployed
 * by then, so the job failed *after* shipping, which skipped every `if:
 * success()` step after it: the lkg tag was never moved (leaving rollback
 * pointing ten commits back) and the project board was never swept.
 *
 * A release that has already shipped must not be marked failed because one
 * portal was a few seconds behind. A portal that is genuinely broken still
 * fails, just after the deadline instead of on the first attempt.
 */
async function probePortals() {
  if (PORTAL_URLS.length === 0) return;
  const deadline = Date.now() + PORTAL_TIMEOUT_S * 1000;
  const lastDetail = new Map();
  let pending = [...PORTAL_URLS];

  for (;;) {
    const results = await Promise.all(pending.map(probeOnce));
    const stillFailing = [];
    for (const r of results) {
      if (r.ok) {
        console.log(`✓ ${r.url} → ${r.detail}`);
      } else {
        stillFailing.push(r.url);
        lastDetail.set(r.url, r.detail);
      }
    }
    if (stillFailing.length === 0) return;

    if (Date.now() > deadline) {
      for (const url of stillFailing) console.log(`✗ ${url} → ${lastDetail.get(url)}`);
      console.error(
        `${stillFailing.length} portal probe(s) still failing after ${PORTAL_TIMEOUT_S}s.`,
      );
      process.exit(1);
    }

    const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    const summary = stillFailing.map((u) => `${u} → ${lastDetail.get(u)}`).join(', ');
    console.log(`… waiting on ${summary}; retrying in ${INTERVAL_S}s (${remaining}s left)`);
    pending = stillFailing;
    await new Promise((r) => setTimeout(r, INTERVAL_S * 1000));
  }
}

await waitForHealth();
await probePortals();
console.log('✅ Smoke passed.');
