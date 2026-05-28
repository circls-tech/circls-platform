/**
 * Build the OpenAPI artifact (`apps/api/openapi.yaml`) — consumed by Phase 18
 * (Flutter) and any other API-client generators we add later.
 *
 * Runs in two modes:
 *  1) With a real DATABASE_URL → boots the server, fetches /openapi.json.
 *  2) Without one (CI/build) → uses a placeholder DATABASE_URL since the spec
 *     emit doesn't touch the DB.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';

process.env.DATABASE_URL ??= 'postgres://placeholder@127.0.0.1:5432/placeholder';
process.env.RUN_WORKER = 'false';

const { buildServer } = await import('../src/server.js');
const { closeDb } = await import('../src/db/client.js');

async function main() {
  const app = await buildServer();
  await app.ready();
  // app.swagger() returns the JSON spec object.
  const spec = app.swagger();
  const outPath = path.resolve(import.meta.dirname, '../openapi.yaml');
  const yamlText = yaml.dump(spec, { sortKeys: false, lineWidth: 120 });
  await fs.writeFile(outPath, yamlText, 'utf8');
  const routeCount = Object.keys((spec as { paths?: Record<string, unknown> }).paths ?? {}).length;
  // eslint-disable-next-line no-console
  console.log(`openapi.yaml written (${routeCount} paths)`);
  await app.close();
  await closeDb();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('openapi:emit failed:', err);
  process.exit(1);
});
