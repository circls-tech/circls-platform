#!/usr/bin/env node
// Push a screen document to the API as the draft, and optionally publish it.
// See docs/SDUI.md. No dependencies beyond Node 24.
//
//   node scripts/sdui/publish.mjs --api https://api.circls.app --token <firebase-id-token> \
//     --app consumer --key explore --file path/to/explore.json [--publish] \
//     [--min-build ios=12,android=12] [--note "why"]
import { readFileSync } from 'node:fs';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[name] = true;
    else { out[name] = next; i++; }
  }
  return out;
}

function parseMinBuild(text) {
  if (!text) return undefined;
  const minBuild = {};
  for (const pair of String(text).split(',')) {
    const [platform, build] = pair.split('=').map((s) => s.trim());
    if (!platform || !/^\d+$/.test(build ?? '')) {
      throw new Error(`--min-build: expected platform=build pairs, got "${pair}"`);
    }
    minBuild[platform] = Number(build);
  }
  return minBuild;
}

async function call(api, token, method, path, body) {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = json.error ?? {};
    const issues = err.details?.issues ? `\n${JSON.stringify(err.details.issues, null, 2)}` : '';
    throw new Error(`${method} ${path} → ${res.status} ${err.code ?? ''} ${err.message ?? ''}${issues}`);
  }
  return json;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { api = 'https://api.circls.app', token, app, key, file } = args;
  if (!token || !app || !key || !file) {
    console.error('Usage: publish.mjs --token <firebase-id-token> --app consumer|partners --key <key> --file <doc.json> [--api <url>] [--publish] [--min-build ios=12,android=12] [--note <text>]');
    process.exit(2);
  }
  const body = JSON.parse(readFileSync(file, 'utf8'));
  const minBuild = parseMinBuild(args['min-build']);
  const note = typeof args.note === 'string' ? args.note : undefined;

  const draft = await call(api, token, 'PUT', `/v1/admin/screens/${app}/${key}/draft`, { body, minBuild, note });
  console.log(`draft saved: ${app}.${key} v${draft.version}`);
  if (args.publish) {
    const published = await call(api, token, 'POST', `/v1/admin/screens/${app}/${key}/publish`);
    console.log(`published: ${app}.${key} v${published.version}`);
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
